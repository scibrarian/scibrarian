import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BLOBS_DIR, UPLOAD_TMP_DIR } from "./config.js";
import { countFilesByHash } from "./db.js";

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

// Multer decodes originalname as latin1; also drop any path the browser or a
// crafted request may have prepended.
export function cleanUploadName(raw: string): string {
  const utf8 = Buffer.from(raw, "latin1").toString("utf8");
  return utf8.replace(/^.*[\\/]/, "").trim() || "upload.pdf";
}

export function blobExists(hash: string): boolean {
  return fs.existsSync(blobPath(hash));
}

// Hash a finished upload and move it into the store; identical content just
// discards the temp file. The rename is same-volume (see UPLOAD_TMP_DIR).
export async function storeBlobFromTemp(tmpPath: string): Promise<{ hash: string }> {
  const hash = await sha256File(tmpPath);
  if (blobExists(hash)) {
    await fs.promises.unlink(tmpPath);
  } else {
    await fs.promises.rename(tmpPath, blobPath(hash));
  }
  return { hash };
}

// Drop blobs that no collection_files row references anymore. Called after
// deleting file rows; ENOENT just means it was already gone.
export function deleteBlobsIfOrphaned(hashes: string[]): void {
  for (const hash of new Set(hashes)) {
    if (countFilesByHash(hash) === 0) {
      try {
        fs.unlinkSync(blobPath(hash));
      } catch {
        /* already gone or locked; harmless either way */
      }
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
