import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_TMP_DIR } from "./config.js";
import { blobExists, blobPath, isPdfFile, storeBlobFromTemp } from "./blobstore.js";
import {
  addCollectionFiles,
  collectionByName,
  createCollection,
  existingPmids,
  holdingsByPmids,
  listCollectionFiles,
  setFileMatched,
  upsertArticles,
} from "./db.js";
import { fetchArticles } from "./pubmed.js";

// The library operations the Pro module orchestrates, implemented here in the
// open repo.
//
// Pro could reach for db.ts and blobstore.ts directly — it runs in the same
// process — and deliberately doesn't. Each of these carries an invariant the
// free tier already depends on, and a second implementation on the other side
// of the split is one that drifts: what "held" means, and the order a blob and
// its row have to be written in.

/**
 * The stored PDF behind a held PMID, for serving to a paired node.
 *
 * Null unless there is a `collection_files` row *and* the blob is on disk. Both
 * halves matter: the row without the bytes is a paper the master lost, and
 * answering with a path to a missing file turns a useful "no" into a download
 * that fails halfway.
 */
export function heldFile(pmid: string): { path: string; fileName: string } | null {
  const row = holdingsByPmids([pmid]).find((r) => r.file_id != null && r.content_hash);
  if (!row?.content_hash || !blobExists(row.content_hash)) return null;
  return { path: blobPath(row.content_hash), fileName: row.file_name || `${pmid}.pdf` };
}

/** Find or create a collection by name. Idempotent, so a pull can call it every time. */
export function ensureCollection(name: string): number {
  return (collectionByName(name) ?? createCollection(name)).id;
}

/**
 * Make sure this library has an `articles` row for the PMID, fetching it from
 * PubMed if it doesn't.
 *
 * **Not optional, and not cosmetic.** Every holdings query — including the one
 * behind /have — reads `FROM articles` and joins collection_files to it. A file
 * row whose PMID has no article row is invisible: the paper would be pulled to
 * disk and then answer *not held* on the very next check, which is the false
 * negative this whole feature exists to prevent, arrived at by a new route.
 *
 * Same job validatePmids does on the import path, for the same reason.
 */
async function ensureArticle(pmid: string): Promise<boolean> {
  if (existingPmids([pmid]).has(pmid)) return true;
  const articles = await fetchArticles([pmid]);
  if (articles.length === 0) return false;
  upsertArticles(articles);
  return true;
}

/**
 * File bytes pulled from a master as a genuinely held paper.
 *
 * Returns null when the bytes aren't a PDF — which is not a formality. These
 * arrive over the network from another instance, and "a master said so" is not
 * a reason to write arbitrary content into the blob store under a .pdf name.
 * The same check guards ordinary uploads.
 *
 * The sequence is the reason this lives here: metadata, then blob, then the
 * row, then the match. Metadata first so a PubMed outage fails the pull with
 * nothing written, rather than leaving bytes on disk the library can't see. A
 * row written before its blob points at nothing; a blob written with no row is
 * invisible and would be GC'd. storeBlobFromTemp is idempotent on content, so
 * pulling a paper the library already stores under a different name costs one
 * row and no bytes.
 */
export async function storePulledFile(o: {
  bytes: Buffer;
  fileName: string;
  pmid: string;
  collectionId: number;
}): Promise<{ fileId: number; hash: string } | null> {
  if (!(await ensureArticle(o.pmid))) return null;

  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
  const tmpPath = path.join(UPLOAD_TMP_DIR, `pull-${crypto.randomUUID()}.pdf`);
  await fs.promises.writeFile(tmpPath, o.bytes);

  if (!(await isPdfFile(tmpPath))) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    return null;
  }

  const { hash } = await storeBlobFromTemp(tmpPath);
  addCollectionFiles(o.collectionId, [{ hash, name: o.fileName }]);
  const file = listCollectionFiles(o.collectionId).find((f) => f.content_hash === hash);
  if (!file) return null;
  // Matched by PMID, because that is literally how it was found: the master was
  // asked about this PMID and answered about this PMID.
  setFileMatched(file.id, o.pmid, "pmid");
  return { fileId: file.id, hash };
}
