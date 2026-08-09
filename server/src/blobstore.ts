import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BLOBS_DIR, UPLOAD_TMP_DIR } from "./config.js";

// Content-addressed store for uploaded PDFs: one file per distinct content,
// named by its SHA-256 hex digest. Rows in collection_files reference blobs by
// hash, so the same paper uploaded to several collections is stored once.

fs.mkdirSync(BLOBS_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

// Uploads that died between multer writing them and the blob-store rename.
for (const name of fs.readdirSync(UPLOAD_TMP_DIR)) {
  try {
    fs.unlinkSync(path.join(UPLOAD_TMP_DIR, name));
  } catch {
    /* another process may hold it; the next startup gets it */
  }
}

export function blobPath(hash: string): string {
  return path.join(BLOBS_DIR, `${hash}.pdf`);
}

// A real PDF regardless of what the filename claims.
export async function isPdfFile(tmpPath: string): Promise<boolean> {
  const fh = await fs.promises.open(tmpPath, "r");
  try {
    const buf = Buffer.alloc(5);
    const { bytesRead } = await fh.read(buf, 0, 5, 0);
    return bytesRead === 5 && buf.toString("latin1") === "%PDF-";
  } finally {
    await fh.close();
  }
}

/**
 * The last path segment of a name that came from outside the process.
 *
 * Every write into `collection_files.file_name` goes through this, because that
 * column is not only a label. The archive route hands it to the zip writer as
 * an entry name, so a stored name that kept its separators is a zip-slip on
 * whoever extracts the download — the file lands wherever the name says, not in
 * the folder they unpacked into.
 *
 * Splitting rather than the obvious `replace(/^.*[\\/]/, "")`: regex `.` does
 * not match a line terminator, so that strip returns "a\n../../evil.pdf"
 * exactly as it found it, separators intact, for any name a filesystem let a
 * newline into.
 */
export function safeFileName(raw: string, fallback = "upload.pdf"): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // Control characters are what turn a name into a second header line or a
  // second zip entry — and the newline that defeated the strip above is one.
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  // "." and ".." name directories, not files, and survive the split intact.
  return clean === "" || clean === "." || clean === ".." ? fallback : clean;
}

// Multer decodes originalname as latin1. The transcode belongs here rather than
// in safeFileName, which also takes names that arrived already decoded — a
// pulled file's Content-Disposition — and a second latin1 pass would mangle
// every non-ASCII one of those.
export function cleanUploadName(raw: string): string {
  return safeFileName(Buffer.from(raw, "latin1").toString("utf8"));
}

export function blobExists(hash: string): boolean {
  return fs.existsSync(blobPath(hash));
}

// The set of blob hashes currently present, from a single directory read. List
// endpoints resolve `exists` for many rows against this instead of an
// fs.existsSync per row — one readdir rather than N blocking stat syscalls.
export function existingBlobHashes(): Set<string> {
  const out = new Set<string>();
  for (const name of fs.readdirSync(BLOBS_DIR)) {
    if (name.endsWith(".pdf")) out.add(name.slice(0, -4));
  }
  return out;
}

// Hash a finished upload and move it into the store; identical content just
// discards the temp file. The rename is same-volume (see UPLOAD_TMP_DIR).
export async function storeBlobFromTemp(tmpPath: string): Promise<{ hash: string }> {
  const hash = await sha256File(tmpPath);
  if (blobExists(hash)) {
    await fs.promises.unlink(tmpPath);
    return { hash };
  }
  try {
    await fs.promises.rename(tmpPath, blobPath(hash));
  } catch (err) {
    // Concurrent identical uploads can race this rename. On Windows, renaming
    // onto an existing blob overwrites — unless the winner's copy is already
    // held open (import scan, download, AV), which fails with EPERM. The store
    // is content-addressed, so if the blob exists now the bytes are already
    // right: drop our redundant temp instead of failing the upload.
    if (!blobExists(hash)) throw err;
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
  return { hash };
}

// Blindly unlink these blobs. Orphanhood is the DB layer's call — see db.ts
// gcBlobsIfOrphaned, which row-deleting functions invoke themselves — the
// store knows nothing about references. ENOENT just means already gone.
export function deleteBlobs(hashes: Iterable<string>): void {
  for (const hash of hashes) {
    try {
      fs.unlinkSync(blobPath(hash));
    } catch {
      /* already gone or locked; harmless either way */
    }
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}
