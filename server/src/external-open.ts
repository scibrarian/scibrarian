import fs from "node:fs";
import path from "node:path";
import { EXTERNAL_OPEN_DIR, IS_DESKTOP, UPLOAD_TMP_DIR } from "./config.js";
import {
  blobExists,
  blobPath,
  isPdfFile,
  safeFileName,
  sha256File,
  storeBlobFromTemp,
} from "./blobstore.js";
import { getCollectionFile, repointFileBlob, savePdfText } from "./db.js";
import { extractPdf } from "./pdf-text.js";
import { errMessage } from "./util.js";

// Opening a stored PDF in whatever this machine already opens PDFs with, for
// the desktop build. Electron's own viewer draws one chrome-less window per
// paper, which is a poor way to read one and a worse way to keep three of them
// side by side — so the shell intercepts the content URL and comes here for a
// path to hand the OS instead (electron/main.mjs).
//
// Handing over the blob itself is what this module exists not to do. The store
// is content-addressed, so the blob's name on disk is a 64-character digest
// rather than the paper's — the viewer's title bar, its recent-files list and
// any "save a copy" would all show that — and a viewer that writes annotations
// in place would leave the bytes no longer matching the name that identifies
// them. Instead a file is *checked out*: copied under its real name, watched,
// and checked back in when the viewer saves.
//
// **Desktop only, and enforced here rather than assumed.** A server deployment
// hands its PDFs to a browser, which renders them and cannot write back — so
// none of this is needed there, and every entry point below refuses outright
// off the desktop build. That is belt and braces on top of nothing mounting
// these on a route: see stored-pdf-immutable.test.ts for why the bytes of a
// stored PDF must never be writable over HTTP.
//
// Checked-out copies are kept until the reader clears them. Nothing here
// deletes on a timer, and the reason is that no timer can answer the only
// question that matters — whether the viewer still has the file open. Deleting
// one that does is the single way this loses work: on macOS and Linux the
// unlink succeeds, the viewer goes on writing into an inode with no name, and
// the save is reported to the user as having worked. A person clearing the
// cache knows what they have open; a clock never does.

// How often a checked-out copy is stat'd for changes. Nothing here is racing
// a clock — a save collected five seconds after it happened is, to everyone
// involved, the same as one collected instantly — so the interval buys
// cross-platform uniformity very cheaply. See watchForSaves.
const POLL_MS = 2_000;

// Ask the filesystem to share the bytes rather than duplicate them, and take a
// real copy where it cannot. A checked-out copy is a duplicate of a paper that
// is almost always only read, so on a filesystem with copy-on-write — APFS,
// which every Mac has had since 2017, and btrfs or XFS on Linux — the cache
// costs nothing until a viewer actually writes, and the write then lands on
// the clone rather than on the blob exactly as it does for a full copy.
//
// NTFS has no equivalent, so Windows pays the bytes. The flag is still right
// there: copyFile falls back to a plain copy on its own, so this is free to
// ask for and never a reason for an open to fail.
const COW = fs.constants.COPYFILE_FICLONE;

// Both ends of the file are read to decide a writer has finished with it — see
// isWholePdf. This is how much of the tail the end marker has to appear in.
const EOF_WINDOW = 2048;

// Windows refuses these in a filename outright, and refuses one whose base is a
// reserved device besides — CON.pdf is still CON. safeFileName is about zip
// entry names and header values and lets all of them through, so a checked-out
// copy, which is a real file in a real directory the user can see, needs more.
const ILLEGAL = /[<>:"|?*]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// What one path component may be: 255 bytes on ext4, 255 UTF-16 units on NTFS
// and APFS. Windows caps the whole path at 260 on top of that, and a checkout
// sits under a workspace uuid several directories down. A single budget in
// UTF-8 bytes settles all three at once — a string's byte count is never below
// its UTF-16 unit count — and what it leaves over clears the deepest Windows
// checkout path. Names really do arrive at the limit: anything exported from a
// cloud drive is named after the share link, and 130 accented characters is
// already 264 bytes.
const NAME_BUDGET = 120;

/** The longest prefix of `s` that fits in `budget` UTF-8 bytes. */
function withinBudget(s: string, budget: number): string {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= budget) return s;
  // Cut on a character boundary. Slicing at a byte lands inside a multi-byte
  // sequence often enough, and what that decodes to is a replacement
  // character rather than a letter.
  let end = budget;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** What to call the copy: the paper's own name, as close as every OS allows. */
function openableName(fileName: string, fileId: number): string {
  const fallback = String(fileId);
  // No separators or control codes (safeFileName), none of the characters
  // Windows refuses outright, and no trailing dot or space for it to drop
  // silently behind our back.
  const scrubbed = safeFileName(fileName, fallback)
    .replace(ILLEGAL, "_")
    .replace(/[. ]+$/, "")
    .replace(/\.pdf$/i, ""); // put back below, so the budget can never eat it
  const base = withinBudget(scrubbed, NAME_BUDGET - ".pdf".length) || fallback;
  return RESERVED.test(base) ? `_${base}.pdf` : `${base}.pdf`;
}

/**
 * The checked-out copies in one file's directory; none is the ordinary case.
 *
 * Documents only, because the copy does not have this directory to itself. A
 * viewer saving into it writes a lock file or a temp file alongside, Finder
 * leaves .DS_Store, and every caller here treats what it is handed as the
 * paper: one hands it to the OS to open, two weigh storing it over the blob.
 * An unfiltered readdir made the first entry in directory order — a dotfile,
 * on most volumes — into all three of those.
 */
function copiesIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return []; // never opened, or swept since
  }
}

/**
 * One directory per file id, so two papers that arrived under the same name can
 * both be open at once, and so the sweep has one copy at a time to reason about.
 */
function checkoutDir(fileId: number): string {
  return path.join(EXTERNAL_OPEN_DIR, String(fileId));
}

/**
 * Check one stored PDF out for an external viewer, and answer with the path to
 * hand the OS.
 *
 * Reuses the copy from an earlier open whenever the library already holds
 * exactly those bytes — reopening a paper you read yesterday copies nothing,
 * and the viewer reopens the same path it remembers.
 */
export async function checkOutForExternalOpen(fileId: number): Promise<string> {
  if (!IS_DESKTOP) throw new Error("Opening in a local viewer is a desktop-only feature.");
  const file = getCollectionFile(fileId);
  if (!file) throw new Error("File not found.");
  if (!blobExists(file.content_hash)) throw new Error("That file's PDF is no longer stored.");

  const dir = checkoutDir(fileId);

  // Whatever copy is already here, under whatever name it is under — rather
  // than testing for the name this code would choose today. A case-sensitive
  // volume that stores a name in a different Unicode normalisation than the
  // database holds it in answers "nothing here" to that test, and would then
  // overwrite the copy it could not see, taking an afternoon of annotations
  // with it. macOS is where the two normalisations meet.
  const [existing] = copiesIn(dir);
  if (existing) {
    // Changes the watch never saw: it dies with the process, so anything the
    // viewer saved after the last quit arrives here instead. Taken before the
    // copy is handed back, since reuse is what would bury them.
    await checkInIfWhole(fileId, existing);
    watchForSaves(fileId, existing);
    return existing;
  }

  const copy = path.join(dir, openableName(file.file_name, fileId));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.copyFile(blobPath(file.content_hash), copy, COW);
  watchForSaves(fileId, copy);
  return copy;
}

// One watcher per checked-out file. Opening the same paper twice is the
// ordinary case — it is still open from an hour ago — and must not arm a
// second one.
const watches = new Map<number, string>();

/**
 * Notice when the viewer writes to the copy.
 *
 * Polled rather than evented, deliberately. fs.watch is a different mechanism
 * on each platform — ReadDirectoryChangesW, inotify, FSEvents, kqueue — and
 * they do not agree about the case this rests on: whether writing into a file
 * already inside a watched directory is an event at all. Some viewers save
 * exactly that way, others write a temp file and rename it over the original,
 * and a watch that misses either one fails silently and loses the work. A stat
 * sees both, identically, on all three systems. What it costs is one stat every
 * POLL_MS per paper actually open, and a save noticed a couple of seconds late
 * — which is no different to anyone, since nothing is waiting on it.
 */
function watchForSaves(fileId: number, copy: string): void {
  if (watches.has(fileId)) return;
  const watcher = fs.watchFile(copy, { interval: POLL_MS }, (now, before) => {
    // A zeroed stat is the file having gone: cleared, or deleted by hand.
    if (now.mtimeMs === 0) return stopWatching(fileId);
    if (now.mtimeMs === before.mtimeMs && now.size === before.size) return;
    void collect(fileId, copy);
  });
  watcher.unref(); // never a reason for the process to stay up
  watches.set(fileId, copy);
}

/** Stop polling one copy. Unrefing the watcher does not do this: it only says
 *  the poll must not hold the process up, and the poll goes on running. */
function stopWatching(fileId: number): void {
  const copy = watches.get(fileId);
  if (copy === undefined) return;
  fs.unwatchFile(copy);
  watches.delete(fileId);
}

/** Something wrote to the copy: decide whether anything actually changed. */
async function collect(fileId: number, copy: string): Promise<void> {
  try {
    if (!fs.existsSync(copy)) return;
    await checkInIfWhole(fileId, copy);
  } catch (err) {
    console.warn(`[external-open] file ${fileId}: ${errMessage(err)}`);
  }
}

/**
 * Take the copy's bytes back into the library, if they are bytes worth taking:
 * the paper's, changed, and a whole document rather than a save caught halfway.
 *
 * The one gate every check-in goes through, rather than a test each caller is
 * trusted to remember — two of the three did not. The reuse path above and the
 * startup sweep below both hashed whatever copy they found and stored it on the
 * strength of the hash differing, so a quit part way through a save left a
 * fragment that the next open wrote over the paper. What that costs is not a
 * bad revision but the document: checkIn repoints the row, and the blob it
 * stops naming is collected the moment nothing references it.
 */
async function checkInIfWhole(fileId: number, copy: string): Promise<void> {
  const file = getCollectionFile(fileId);
  if (!file) return; // the row went with its collection; only a clear takes the copy
  const hash = await sha256File(copy);
  if (hash === file.content_hash) return; // opened and read, not edited
  // A save the viewer is still in the middle of, or one it never finished.
  // Deliberately no retry: a write on the way to a finished file moves the
  // mtime, so the poll comes back on its own, and a file that stops halfway
  // stays in the cache as the fragment it is until the reader clears it.
  if (!(await isWholePdf(copy))) return;
  await checkIn(fileId, copy, hash);
}

/**
 * Take the bytes an external viewer wrote back into the library: store them,
 * point the row at them, and re-index the text so search answers for the
 * document that is actually there now.
 */
async function checkIn(fileId: number, copy: string, hash: string): Promise<void> {
  // Through a temp file, because storeBlobFromTemp renames what it is given
  // into the store — and what it would be given here is the file the viewer
  // still has open. In the upload directory so that rename stays same-volume.
  await fs.promises.mkdir(UPLOAD_TMP_DIR, { recursive: true });
  const tmp = path.join(UPLOAD_TMP_DIR, `checkin-${fileId}-${hash.slice(0, 16)}.pdf`);
  await fs.promises.copyFile(copy, tmp, COW);
  const { hash: stored } = await storeBlobFromTemp(tmp);
  if (!repointFileBlob(fileId, stored)) return;

  // The text index is keyed by content_hash, so the old extraction went with
  // the old blob and this row has none until the new one is parsed. Its own
  // try/catch: a document pdfjs cannot read is still correctly stored and
  // correctly pointed at, and only its searchability is in question.
  try {
    const extracted = await extractPdf(blobPath(stored));
    savePdfText({
      contentHash: stored,
      text: extracted.fullText,
      pages: extracted.pages,
      truncated: extracted.truncated,
    });
  } catch (err) {
    console.warn(`[external-open] file ${fileId}: full-text re-index failed: ${errMessage(err)}`);
  }
  console.log(`[external-open] file ${fileId}: took back changes from the system viewer`);
}

/**
 * Both ends of a PDF, as a cheap "the writer has finished" test: a file caught
 * mid-save has the header and, as often as not, no trailer yet. isPdfFile
 * answers for the first half; the end marker is what says the document is whole.
 */
async function isWholePdf(filePath: string): Promise<boolean> {
  if (!(await isPdfFile(filePath))) return false;
  const fh = await fs.promises.open(filePath, "r");
  try {
    const { size } = await fh.stat();
    const len = Math.min(EOF_WINDOW, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString("latin1").includes("%%EOF");
  } finally {
    await fh.close();
  }
}

/**
 * Every checked-out copy on disk, with the file id whose directory it sits in.
 */
function everyCopy(): { fileId: number; copy: string }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(EXTERNAL_OPEN_DIR, { withFileTypes: true });
  } catch {
    return []; // nothing has ever been opened externally
  }
  const out: { fileId: number; copy: string }[] = [];
  for (const entry of entries) {
    const fileId = Number(entry.name);
    if (!entry.isDirectory() || !Number.isInteger(fileId)) continue;
    for (const copy of copiesIn(path.join(EXTERNAL_OPEN_DIR, entry.name))) out.push({ fileId, copy });
  }
  return out;
}

/**
 * Collect whatever an earlier session's viewers saved after the process went
 * away. Called once, at startup, by the desktop build.
 *
 * This is the half of the old sweep that had to survive its retirement. The
 * watch dies with the process, so a paper annotated at five o'clock and a quit
 * at four leaves a save nobody has taken. Only two things ever collect it: this
 * pass, or the reader happening to open that same paper again. Without the
 * first, an annotation can sit in the cache indefinitely while the library, and
 * every search over it, still answers with the document as it was.
 *
 * Deletes nothing. Copies are the reader's to clear — see clearCheckouts.
 */
export async function collectPendingCheckins(): Promise<void> {
  if (!IS_DESKTOP) return;
  for (const { fileId, copy } of everyCopy()) {
    try {
      await checkInIfWhole(fileId, copy);
    } catch (err) {
      console.warn(`[external-open] collecting file ${fileId}: ${errMessage(err)}`);
    }
  }
}

/** What the cache is costing, for the reader deciding whether to clear it. */
export function checkoutCacheStats(): { files: number; bytes: number } {
  if (!IS_DESKTOP) return { files: 0, bytes: 0 };
  let bytes = 0;
  const copies = everyCopy();
  for (const { copy } of copies) {
    try {
      bytes += fs.statSync(copy).size;
    } catch {
      /* removed between the listing and the stat */
    }
  }
  return { files: copies.length, bytes };
}

/**
 * Empty the cache, on the reader's say-so.
 *
 * Collects before it deletes, without exception. Otherwise this button is the
 * one way to throw away an annotation — the poll behind a checked-out copy
 * takes a save within seconds, but "within seconds" is not "before the click".
 */
export async function clearCheckouts(): Promise<{ files: number; bytes: number }> {
  if (!IS_DESKTOP) return { files: 0, bytes: 0 };
  await collectPendingCheckins();
  const freed = checkoutCacheStats();
  // The polls go with the files they were watching. Left armed they would each
  // stat a path with nothing at it, and the checkout that re-creates the copy
  // would decline to arm a fresh one because the map still claimed this id.
  for (const fileId of [...watches.keys()]) stopWatching(fileId);
  await fs.promises.rm(EXTERNAL_OPEN_DIR, { recursive: true, force: true });
  console.log(`[external-open] cleared ${freed.files} cached file(s), ${freed.bytes} bytes`);
  return freed;
}
