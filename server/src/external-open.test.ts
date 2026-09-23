import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import type { CacheStats, ClearedCache } from "./types.js";

// Every entry point in external-open.ts refuses unless this is the desktop
// build, so the tests are one. Set before openTempDb, which is what first pulls
// config.ts in — it reads the environment once, at evaluation.
process.env.SCIBRARIAN_DESKTOP = "1";

// Handing a stored PDF to the machine's own viewer, which is the one place an
// outside program writes into the library.
//
// A filesystem test rather than a unit test, because every way of getting this
// wrong loses work silently. The copy is what the user reads and annotates for
// an afternoon; the blob is what the library thinks it holds. If those two part
// company without a check-in, the annotations are on disk, unreachable, and
// nothing anywhere reports a problem.
//
// The three ways a save comes back are each their own test: the watch (the app
// was running), the next checkout (it wasn't), and the startup sweep (it isn't
// yet). They are separate code, and only the first is the easy case.

let db: Db;
let blobPath: (hash: string) => string;
let checkOutForExternalOpen: (fileId: number) => Promise<string>;
let collectPendingCheckins: () => Promise<void>;
let checkoutCacheStats: () => CacheStats;
let clearCheckouts: () => Promise<ClearedCache>;
let EXTERNAL_OPEN_DIR: string;
let UPLOAD_TMP_DIR: string;

let collection: number;

/**
 * A real one-page PDF, small enough to sit in a test and complete enough for
 * pdfjs to read the text back out — which matters here, because a check-in
 * re-indexes the document it has just stored, and a stub PDF would let that
 * half of it pass while doing nothing.
 */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * A stored paper: bytes in the blob store, a row pointing at them, indexed.
 *
 * The text defaults to the file name because the store is content-addressed and
 * these fixtures must not collide — two papers with identical bytes are one
 * blob and, inside a collection, one row, so a shared body would quietly hand
 * two tests the same file id.
 */
function store(name: string, text = name): number {
  const bytes = minimalPdf(text);
  const hash = sha256(bytes);
  fs.writeFileSync(blobPath(hash), bytes);
  db.addCollectionFiles(collection, [{ hash, name }]);
  db.savePdfText({ contentHash: hash, text, pages: 1, truncated: false });
  const row = db.listCollectionFiles(collection).find((f) => f.content_hash === hash);
  if (!row) throw new Error(`fixture ${name} collided with another`);
  return row.id;
}

const hashOf = (fileId: number): string => db.getCollectionFile(fileId)!.content_hash;

const indexedText = (fileId: number): string | undefined =>
  (
    db.db.prepare("SELECT text FROM pdf_text WHERE content_hash = ?").get(hashOf(fileId)) as
      | { text: string }
      | undefined
  )?.text;

const isIndexed = (hash: string): boolean =>
  db.db.prepare("SELECT 1 FROM pdf_text WHERE content_hash = ?").get(hash) !== undefined;

/** A copy placed the way a finished session left it: no watch armed over it. */
function copyLeftBehind(fileId: number, name: string, bytes: Buffer, ageMs = 0): string {
  const dir = path.join(EXTERNAL_OPEN_DIR, String(fileId));
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, name);
  fs.writeFileSync(copy, bytes);
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(copy, when, when);
  }
  return copy;
}

/**
 * Take away a half-finished save a test put there on purpose.
 *
 * clearCheckouts keeps what the library could not take — that is the whole
 * point of it — so a fragment written by one test outlives every clear and is
 * still being counted by the cache tests further down. Each test that makes one
 * drops it again, rather than the suite depending on an order.
 */
function dropFragment(copy: string): void {
  fs.rmSync(copy, { force: true });
}

/**
 * How long a save may take to come back, and how long a test that waits for one
 * must be allowed to run.
 *
 * Two numbers rather than one because they are two different budgets, and
 * getting them the wrong way round is silent. A save is noticed by a 2-second
 * stat poll and then hashed, copied, stored and re-indexed through pdfjs, which
 * is comfortable inside COLLECTED on a developer's machine and a good deal less
 * comfortable on a CI runner with two cores and fifty other test files in
 * flight. But vitest's own default test timeout is 5s, under COLLECTED — so a
 * test that only sets the wait gets killed while the wait is still running,
 * which is not a failure of the thing under test and does not say so either.
 * Three tests here were written that way and passed for weeks, because the poll
 * usually lands in two seconds and only CI was ever slow enough to find out.
 *
 * The first pass at this set 10s and 20s, which fixed the shape of the failure
 * without fixing the failure. CI stopped reporting a test timeout and started
 * exhausting the 10s wait instead, which surfaces as the last assertion the
 * wait tried: `expected <hash> not to be <hash>`. That reads like the watch
 * never collecting the save, and sent the next reader looking at the watch —
 * the same misdirection in a new spelling. The test takes ~2s on a developer
 * machine, so both numbers are now far past what the work needs. A larger
 * budget costs only how long a real breakage takes to report: the collection
 * either happens or it does not, and no passing run waits for the timeout.
 *
 * Keep COLLECTED under OUTLASTS_THE_POLL. That way the wait is what runs out,
 * and the failure at least names the hash that never changed; the other way
 * round vitest kills the test first and says only that it timed out.
 */
const COLLECTED = { timeout: 30_000, interval: 50 };
const OUTLASTS_THE_POLL = 60_000;

/**
 * Empty the cache, and say so, for a test whose subject is what one sweep does
 * to one copy.
 *
 * collectPendingCheckins walks every copy on disk. A test that leaves other
 * copies in front of its own gets them collected first, which is enough to make
 * two of the tests below pass for reasons that have nothing to do with what
 * they are checking — a synchronous delete meant for the gap inside one
 * check-in lands inside an earlier one instead, and two sweeps meant to overlap
 * on one file reach it at different moments. Asserted rather than assumed,
 * because that failure is invisible: both tests go green.
 */
async function onlyCopyInCache(): Promise<void> {
  await clearCheckouts();
  expect(checkoutCacheStats()).toEqual({ files: 0, bytes: 0, unsaved: 0 });
}

beforeAll(async () => {
  db = await openTempDb("external-open");
  // After openTempDb: these read BLOBS_DIR at evaluation and EXTERNAL_OPEN_DIR
  // is derived from it, so none of them may be imported until the environment
  // points at the temp directory.
  ({ blobPath } = await import("./blobstore.js"));
  ({ EXTERNAL_OPEN_DIR, UPLOAD_TMP_DIR } = await import("./config.js"));
  ({ checkOutForExternalOpen, collectPendingCheckins, checkoutCacheStats, clearCheckouts } =
    await import("./external-open.js"));
  collection = db.createCollection("Reading").id;
});

afterAll(async () => {
  // Every checkout above armed a watch, and a watch outlives the suite that
  // armed it: the next tick after this line would call getCollectionFile on a
  // closed database, and the temp directory would be left for whatever file
  // this worker picks up next. clearCheckouts is what releases both, and it
  // touches the database, so it has to go first.
  await clearCheckouts();
  closeTempDb();
});

describe("checking a stored PDF out for the system viewer", () => {
  it("hands over a copy under the paper's own name, never the blob", async () => {
    const id = store("Smith 2021.pdf");
    const copy = await checkOutForExternalOpen(id);

    // The whole reason a copy exists: the blob is named by its digest, and the
    // viewer's title bar, its recent-files list and any "save as" show that.
    expect(path.basename(copy)).toBe("Smith 2021.pdf");
    expect(copy).not.toBe(blobPath(hashOf(id)));
    expect(fs.readFileSync(copy)).toEqual(fs.readFileSync(blobPath(hashOf(id))));
  });

  it("reuses the copy rather than writing it again", async () => {
    const id = store("Reopened.pdf");
    const first = await checkOutForExternalOpen(id);
    // Backdated, because a second copyFile is exactly what would reset it.
    const when = new Date(Date.now() - 60_000);
    fs.utimesSync(first, when, when);
    const stamp = fs.statSync(first).mtimeMs;

    const second = await checkOutForExternalOpen(id);
    expect(second).toBe(first);
    expect(fs.statSync(second).mtimeMs).toBe(stamp);
  });

  it("makes a name the filesystem would refuse into one it takes", async () => {
    // Separators, the characters Windows rejects outright, and the trailing dot
    // it drops silently — which would leave us disagreeing with the OS about
    // what the file we had just written is called.
    const hostile = store('../../up: "40%"? .pdf', "hostile name");
    const copy = await checkOutForExternalOpen(hostile);
    expect(path.dirname(copy)).toBe(path.join(EXTERNAL_OPEN_DIR, String(hostile)));
    expect(path.basename(copy)).toBe("up_ _40%__ .pdf");

    // CON.pdf is still the console device as far as Windows is concerned, and
    // a name with no extension is not something the OS can route to a viewer.
    expect(path.basename(await checkOutForExternalOpen(store("CON.pdf", "reserved")))).toBe(
      "_CON.pdf"
    );
    expect(path.basename(await checkOutForExternalOpen(store("no-extension", "bare")))).toBe(
      "no-extension.pdf"
    );

    // Win32 reads the device as everything up to the *first* dot, so these are
    // AUX and CON too — and "Aux. material.pdf" is how supplementary material
    // gets named all the time. Testing the whole base let both through to a
    // copyFile on Windows that could only ever fail, leaving the reader with
    // "Scibrarian could not open that PDF" and nothing to do about it.
    expect(path.basename(await checkOutForExternalOpen(store("Aux. material.pdf", "aux dot")))).toBe(
      "_Aux. material.pdf"
    );
    expect(path.basename(await checkOutForExternalOpen(store("CON.supp.pdf", "con dot")))).toBe(
      "_CON.supp.pdf"
    );
    // Trailing spaces are dropped by Win32 before it looks, so this is AUX as
    // well — and the scrub's own trailing-space strip does not reach it, being
    // anchored to the end of the whole name rather than the first segment.
    expect(path.basename(await checkOutForExternalOpen(store("AUX .notes.pdf", "aux space")))).toBe(
      "_AUX .notes.pdf"
    );
    // Not a device: the segment merely starts with one.
    expect(path.basename(await checkOutForExternalOpen(store("Auxiliary.pdf", "not aux")))).toBe(
      "Auxiliary.pdf"
    );

    // The proof that the scrub was enough: the OS took all of them.
    expect(fs.existsSync(copy)).toBe(true);
  });

  it("keeps a name inside what a path component may be", async () => {
    // 255 characters is the whole of a component on ext4, NTFS and APFS alike,
    // before any of the directories above it are counted — and names do arrive
    // at it: anything exported from a cloud drive is named after the share
    // link. The reference folder in this repo has one at exactly 255.
    const copy = await checkOutForExternalOpen(store(`${"A".repeat(300)}.pdf`, "a long name"));
    expect(path.basename(copy).endsWith(".pdf")).toBe(true);
    expect(Buffer.byteLength(path.basename(copy), "utf8")).toBeLessThanOrEqual(120);
    expect(fs.existsSync(copy)).toBe(true); // the filesystem took it

    // Budgeted in bytes, not characters, because ext4 counts bytes: 130
    // accented characters is 264 of them, refused on Linux while fitting
    // comfortably on the other two.
    const accented = await checkOutForExternalOpen(store(`${"é".repeat(200)}.pdf`, "accented"));
    const base = path.basename(accented);
    expect(Buffer.byteLength(base, "utf8")).toBeLessThanOrEqual(120);
    expect(base).not.toContain("\uFFFD"); // and never cut through a character
    expect(fs.existsSync(accented)).toBe(true);
  });

  it("is not fooled by a file the viewer left beside the copy", async () => {
    const id = store("Beside a sidecar.pdf", "the paper itself");
    const before = hashOf(id);
    const copy = await checkOutForExternalOpen(id);
    // Viewers write lock and temp files into the directory they are saving in,
    // and Finder leaves a .DS_Store, which sorts ahead of the copy besides.
    // Taken for the copy, this is handed to the OS as the paper — and hashes
    // differently from the row, so the reuse path stores it as the paper too.
    fs.writeFileSync(path.join(path.dirname(copy), ".DS_Store"), "not a pdf at all");

    expect(await checkOutForExternalOpen(id)).toBe(copy);
    expect(hashOf(id)).toBe(before);
    expect(fs.existsSync(blobPath(before))).toBe(true);
    expect(indexedText(id)).toContain("the paper itself");
  });

  it("refuses a file whose blob has gone", async () => {
    const id = store("Orphaned.pdf");
    fs.unlinkSync(blobPath(hashOf(id)));
    await expect(checkOutForExternalOpen(id)).rejects.toThrow(/no longer stored/);
  });
});

describe("taking back what the viewer saved", () => {
  it("collects a save while the app is running", async () => {
    const id = store("Annotated.pdf", "before highlighting");
    const before = hashOf(id);
    const copy = await checkOutForExternalOpen(id);

    fs.writeFileSync(copy, minimalPdf("after highlighting"));
    await vi.waitFor(() => expect(hashOf(id)).not.toBe(before), COLLECTED);

    expect(fs.existsSync(blobPath(hashOf(id)))).toBe(true);
    expect(indexedText(id)).toContain("after highlighting");
    // The bytes the row used to name are referenced by nothing now, and the
    // text extracted from them would otherwise keep answering searches.
    expect(fs.existsSync(blobPath(before))).toBe(false);
    expect(isIndexed(before)).toBe(false);
  }, OUTLASTS_THE_POLL);

  it("leaves a save still in progress alone", async () => {
    const id = store("Halfway.pdf");
    const before = hashOf(id);
    const copy = await checkOutForExternalOpen(id);

    // A PDF header and no end marker: what a viewer part way through writing
    // one looks like. Storing this would replace the paper with a fragment.
    fs.writeFileSync(copy, "%PDF-1.4\nnot finished yet");
    // Long enough for the stat poll to have seen it more than once.
    await new Promise((r) => setTimeout(r, 5_000));
    expect(hashOf(id)).toBe(before);
    dropFragment(copy);
  }, OUTLASTS_THE_POLL);

  it("follows the copy when it comes back under a different name", async () => {
    const id = store("Renamed by the reader.pdf", "before the rename");
    const before = hashOf(id);
    const first = await checkOutForExternalOpen(id);
    // The reader renames the copy in Finder, or removes it and reopens the
    // paper. The next checkout hands back whatever is in the directory, so the
    // path this file is watched at and the path the viewer has are now two
    // different things — and the watch was armed on the file id alone, so it
    // stayed on the old one and the new copy's saves were collected by nobody.
    const renamed = path.join(path.dirname(first), "Renamed by the reader (1).pdf");
    fs.renameSync(first, renamed);

    const again = await checkOutForExternalOpen(id);
    expect(again).toBe(renamed);

    fs.writeFileSync(renamed, minimalPdf("saved under the new name"));
    await vi.waitFor(() => expect(hashOf(id)).not.toBe(before), COLLECTED);
    expect(indexedText(id)).toContain("saved under the new name");
  }, OUTLASTS_THE_POLL);

  it("collects a save the app was not running for, at the next open", async () => {
    const id = store("Offline.pdf", "before the quit");
    const before = hashOf(id);
    // No watch was ever armed over this one — the session that opened it is
    // gone, which is what every quit with a PDF still open leaves behind.
    copyLeftBehind(id, "Offline.pdf", minimalPdf("saved after the app quit"));

    const copy = await checkOutForExternalOpen(id);
    expect(hashOf(id)).not.toBe(before);
    expect(indexedText(id)).toContain("saved after the app quit");
    // And the viewer is pointed back at the file holding those bytes, rather
    // than at a fresh copy of the blob they have just replaced.
    expect(fs.readFileSync(copy).toString("latin1")).toContain("saved after the app quit");
  });

  it("does not write a half-finished save over the paper at the next open", async () => {
    const id = store("Quit mid-save.pdf", "the whole paper");
    const before = hashOf(id);
    // A header and no end marker: what quitting part way through a save leaves
    // behind. Its hash differs from the row's, which was the whole of what this
    // path asked before storing it over the paper and collecting the blob.
    const copy = copyLeftBehind(id, "Quit mid-save.pdf", Buffer.from("%PDF-1.4\nnever finished"));

    await checkOutForExternalOpen(id);

    expect(hashOf(id)).toBe(before);
    expect(fs.existsSync(blobPath(before))).toBe(true);
    expect(indexedText(id)).toContain("the whole paper");
    // Left alone rather than quietly dropped.
    expect(fs.existsSync(copy)).toBe(true);
    dropFragment(copy);
  });
});

describe("two check-ins for one file at once", () => {
  // An invariant test, and not a test of the guard in checkInIfWhole — it
  // passes with that guard and the per-attempt temp name both reverted, which
  // was checked rather than assumed. The damage they prevent turns on whether
  // both copyFile calls land before both of storeBlobFromTemp's hashes, and
  // nothing here can pin that down: the benign interleaving, where the second
  // pass rebuilds its temp after the first has renamed its own away, is just as
  // likely and leaves no trace. What this does hold to is the end state, which
  // is the thing a future change would break noisily.
  it("leaves one save collected, indexed, and nothing reported outstanding", async () => {
    // The sweep below walks the whole cache, so this one has to be the whole of
    // it: with another copy ahead of this file in the listing, the two passes
    // reach it at different times and overlap on nothing.
    await onlyCopyInCache();
    const id = store("Saved twice at once.pdf", "before the double save");
    const before = hashOf(id);
    const copy = await checkOutForExternalOpen(id);
    fs.writeFileSync(copy, minimalPdf("saved once, collected once"));

    // Both passes over the same copy, overlapping deliberately. Reachable in
    // the app: the poll fires again while a large PDF's hash, copy and text
    // extraction are still running, and a clear sweeps from another direction.
    //
    // Two of these used to share one temp path, named after the file id and the
    // hash — which are exactly what two check-ins of one save have in common.
    // Whichever renamed it into the store first left the other's
    // storeBlobFromTemp hashing a path that was no longer there, so the loser
    // threw ENOENT over a save that had in fact been taken perfectly. That is
    // what the count below is about: a spurious "your changes are not in the
    // library" is the same sentence as the true one, and teaches the reader to
    // disbelieve it.
    await Promise.all([collectPendingCheckins(), collectPendingCheckins()]);

    const now = hashOf(id);
    expect(now).not.toBe(before);
    expect(indexedText(id)).toContain("saved once, collected once");
    // The save went in, so nothing is outstanding — no false alarm from the
    // pass that lost. What the guard is for, though not what proves it.
    expect(checkoutCacheStats().unsaved).toBe(0);
    // The blob's name is its digest. Not a race this code can lose — copyFile
    // closes before it returns and the store handles concurrent identical
    // writes itself — but the cheapest possible check that it has not started.
    expect(sha256(fs.readFileSync(blobPath(now)))).toBe(now);
    // Nothing left in the upload directory to be renamed into the store later.
    expect(fs.readdirSync(UPLOAD_TMP_DIR).filter((n) => n.startsWith("checkin-"))).toEqual([]);
  });
});

describe("when the paper goes while its save is being taken back", () => {
  it("leaves no blob in the store that nothing points at", async () => {
    // Same reason as the overlap test above: the delete below has to land in
    // the gap inside *this* file's check-in, and it lands in whichever one the
    // sweep happens to be inside when it runs.
    await onlyCopyInCache();
    const id = store("Deleted mid-checkin.pdf", "before the deletion");
    const annotated = minimalPdf("annotated, and then the paper was deleted");
    const orphan = sha256(annotated);
    const copy = copyLeftBehind(id, "Deleted mid-checkin.pdf", annotated);

    // The row is read synchronously, before the first await, so the sweep has
    // already decided this file exists. Deleting it here lands during the hash,
    // and repointFileBlob then refuses — there is nothing left to point — after
    // storeBlobFromTemp has moved the bytes into the store. That order is
    // deliberate, so a crash leaves an unreferenced blob rather than a row
    // naming bytes that are not there; what it needs is for the unreferenced
    // blob to be collected rather than left in the store forever.
    const pending = collectPendingCheckins();
    db.deleteCollectionFile(id);
    await pending;

    expect(db.getCollectionFile(id)).toBeUndefined();
    expect(fs.existsSync(blobPath(orphan))).toBe(false);
    expect(isIndexed(orphan)).toBe(false);
    dropFragment(copy);
  });

  it("keeps a blob another row in the collection turns out to hold", async () => {
    // The other way repointFileBlob refuses: a sibling row already holds these
    // bytes, so the collection would end up with two rows on one hash. The blob
    // is not an orphan — the sibling is pointing at it — and the cleanup above
    // must not be what deletes a paper that is still in the library.
    await onlyCopyInCache();
    const shared = minimalPdf("the bytes both rows would hold");
    const sibling = store("Already holds them.pdf", "the bytes both rows would hold");
    const id = store("Saved into a clash.pdf", "something else to begin with");
    const copy = copyLeftBehind(id, "Saved into a clash.pdf", shared);

    await collectPendingCheckins();

    expect(hashOf(sibling)).toBe(sha256(shared));
    expect(fs.existsSync(blobPath(hashOf(sibling)))).toBe(true);
    expect(indexedText(sibling)).toContain("the bytes both rows would hold");
    dropFragment(copy);
  });
});

describe("collecting at startup", () => {
  it("takes a save the process was not running for", async () => {
    const id = store("Recovered.pdf", "before the crash");
    const before = hashOf(id);
    const copy = copyLeftBehind(id, "Recovered.pdf", minimalPdf("recovered"));

    await collectPendingCheckins();

    expect(hashOf(id)).not.toBe(before);
    expect(indexedText(id)).toContain("recovered");
    // Collected, never deleted. What is on disk is now what the library holds,
    // and it stays there until the reader says otherwise.
    expect(fs.existsSync(copy)).toBe(true);
  });

  it("leaves a copy that has nothing to give exactly where it is", async () => {
    const id = store("Untouched.pdf");
    const copy = copyLeftBehind(id, "Untouched.pdf", minimalPdf("Untouched.pdf"), 400 * 86_400_000);

    await collectPendingCheckins();

    // Over a year old and identical to the library, which under the old sweep
    // was every reason to drop it. Nothing here deletes on age any more.
    expect(fs.existsSync(copy)).toBe(true);
  });

  it("does not store a truncated copy over the paper", async () => {
    const id = store("Truncated.pdf");
    const before = hashOf(id);
    const dir = path.join(EXTERNAL_OPEN_DIR, String(id));
    fs.mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, "Truncated.pdf");
    fs.writeFileSync(copy, "%PDF-1.4\nnever finished");

    await collectPendingCheckins();

    expect(hashOf(id)).toBe(before);
    dropFragment(copy);
  });
});

describe("the cache the reader controls", () => {
  it("reports what it is holding", async () => {
    await clearCheckouts();
    expect(checkoutCacheStats()).toEqual({ files: 0, bytes: 0, unsaved: 0 });

    const first = await checkOutForExternalOpen(store("Counted one.pdf"));
    await checkOutForExternalOpen(store("Counted two.pdf"));

    const stats = checkoutCacheStats();
    expect(stats.files).toBe(2);
    expect(stats.bytes).toBe(fs.statSync(first).size * 2); // same fixture size
    // Opened and read, not edited: nothing is outstanding.
    expect(stats.unsaved).toBe(0);
  });

  it("collects before it clears, so the button cannot lose an annotation", async () => {
    const id = store("Annotated then cleared.pdf", "before");
    const before = hashOf(id);
    const copy = await checkOutForExternalOpen(id);
    // Saved and cleared in the same breath — faster than the poll behind the
    // copy, which is the window this ordering exists to close.
    fs.writeFileSync(copy, minimalPdf("highlighted, then cleared"));

    const freed = await clearCheckouts();

    expect(hashOf(id)).not.toBe(before);
    expect(indexedText(id)).toContain("highlighted, then cleared");
    expect(freed.files).toBeGreaterThan(0);
    expect(fs.existsSync(EXTERNAL_OPEN_DIR)).toBe(false);
  });

  it("keeps a copy whose changes it could not take, and clears the rest", async () => {
    await clearCheckouts();
    const unfinished = store("Never finished saving.pdf");
    const before = hashOf(unfinished);
    // A save the viewer began and never completed. It is not a document the
    // library can store — and it is also the only copy of whatever the reader
    // did to that paper, so deleting it is the one thing this button must not
    // do. The old pass logged it and removed the directory anyway.
    const fragment = copyLeftBehind(
      unfinished,
      "Never finished saving.pdf",
      Buffer.from("%PDF-1.4\nhalf a save")
    );
    const ordinary = await checkOutForExternalOpen(store("Nothing to keep.pdf"));

    const cleared = await clearCheckouts();

    expect(fs.existsSync(fragment)).toBe(true);
    // Unsaved, not blocked: the distinction is the whole of what the reader is
    // told, and a fragment is the case where their changes are the ones at risk.
    expect(cleared.unsaved).toBe(1);
    expect(cleared.blocked).toBe(0);
    expect(hashOf(unfinished)).toBe(before);
    // And the copy that had nothing to give went in the same pass: one file the
    // library cannot take does not hold the whole cache on disk.
    expect(fs.existsSync(ordinary)).toBe(false);
    expect(cleared.files).toBe(1);

    dropFragment(fragment);
  });

  it("says how many copies are holding changes the library does not have", async () => {
    await clearCheckouts();
    expect(checkoutCacheStats().unsaved).toBe(0);

    const id = store("Reported as unsaved.pdf");
    const before = hashOf(id);
    copyLeftBehind(id, "Reported as unsaved.pdf", Buffer.from("%PDF-1.4\nhalf a save"));
    // The startup sweep is what looks at every copy, so it is what discovers
    // this one — a failed check-in used to be a console warning and nothing a
    // reader could ever see.
    await collectPendingCheckins();

    expect(checkoutCacheStats().unsaved).toBe(1);
    expect(hashOf(id)).toBe(before);

    // And it stops being outstanding the moment the bytes do get in. Saved over
    // with a document that is whole this time, which the next sweep can take.
    const copy = copyLeftBehind(id, "Reported as unsaved.pdf", minimalPdf("finished on the retry"));
    await collectPendingCheckins();

    expect(checkoutCacheStats().unsaved).toBe(0);
    expect(indexedText(id)).toContain("finished on the retry");
    dropFragment(copy);
  });

  it("keeps a copy it could not remove, and does not call that a lost change", async () => {
    await onlyCopyInCache();
    const id = store("Still open in a viewer.pdf");
    const copy = await checkOutForExternalOpen(id);

    // Windows refuses to unlink a file a viewer is still holding, where POSIX
    // allows it — so on the machine running this suite the branch is
    // unreachable and the failure is injected rather than provoked. Narrowed to
    // this one path, because clearCheckouts calls rm on the directory and on
    // the cache root too, and those have to go on working.
    const realRm = fs.promises.rm;
    const rm = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation((target, options) =>
        target === copy
          ? Promise.reject(Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }))
          : realRm(target, options)
      );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let cleared;
    // Read before the restore, not after: mockRestore drops the call history
    // along with the implementation, so asserting on the spy afterwards asserts
    // against an empty one and passes for a clear that warned about nothing.
    let warnings = 0;
    try {
      cleared = await clearCheckouts();
      warnings = warn.mock.calls.length;
    } finally {
      rm.mockRestore();
      warn.mockRestore();
    }

    // Blocked, never unsaved. The check-in ran first and found the library
    // already holding these bytes, so only the removal failed and nothing of
    // the reader's is at stake — which is the whole reason the two are counted
    // apart, and why the panel tells them so in different words.
    expect(cleared).toEqual({ files: 0, bytes: 0, unsaved: 0, blocked: 1 });
    expect(fs.existsSync(copy)).toBe(true);
    expect(checkoutCacheStats().unsaved).toBe(0);
    // Logged for whoever can see a console, since the reader's own report says
    // only that it could not be removed.
    expect(warnings).toBeGreaterThan(0);

    // The real rm is back, so this is the ordinary path again.
    fs.rmSync(copy, { force: true });
  });

  it("leaves the library able to open the paper again afterwards", async () => {
    const id = store("Reopened after clearing.pdf");
    await checkOutForExternalOpen(id);
    await clearCheckouts();

    // The watch went with the file it was watching; if it had not, this
    // checkout would decline to arm a fresh one and the next save would be
    // collected by nothing at all.
    const again = await checkOutForExternalOpen(id);
    expect(fs.existsSync(again)).toBe(true);

    const before = hashOf(id);
    fs.writeFileSync(again, minimalPdf("annotated after a clear"));
    await vi.waitFor(() => expect(hashOf(id)).not.toBe(before), COLLECTED);
    expect(indexedText(id)).toContain("annotated after a clear");
  }, OUTLASTS_THE_POLL);
});
