import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_TMP_DIR } from "./config.js";
import { blobExists, blobPath, isPdfFile, safeFileName, storeBlobFromTemp } from "./blobstore.js";
import {
  addCollectionFiles,
  collectionByName,
  collectionFileByHash,
  createCollection,
  existingPmids,
  getCollectionFile,
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

/**
 * Files in a collection that are matched to a paper.
 *
 * The push candidates. Filtered to `matched` here rather than at the call site
 * because the reason is an invariant of this schema, not of the Pro module:
 * identity between instances is the PMID, and a file without one cannot be
 * filed by whoever receives it.
 *
 * `file_name` is sanitised on the way out, like every other read of that column
 * (see the archive and zip routes). Rows written before the column was cleaned
 * on the way in are still in the database, and this one is read to build an
 * outbound HTTP request — a name carrying a newline is a second header, and one
 * carrying a path is a traversal at whatever receives it. The far end sanitises
 * too, but by then the header is already written, so it cannot be the only
 * place this happens.
 *
 * Each row carries the collection it came from, so a caller holding a candidate
 * always holds the pair readFileBytes needs. Rebuilding that pairing from two
 * separate values is how a file ends up read against the wrong collection.
 */
export function matchedFilesIn(
  collectionId: number
): { id: number; collection_id: number; pmid: string; file_name: string }[] {
  return listCollectionFiles(collectionId).flatMap((f) =>
    f.match_status === "matched" && f.pmid
      ? [
          {
            id: f.id,
            collection_id: collectionId,
            pmid: f.pmid,
            file_name: safeFileName(f.file_name, `${f.pmid}.pdf`),
          },
        ]
      : []
  );
}

/**
 * The stored bytes for one file row, read *as part of* a collection.
 *
 * Null when the row is gone, when its blob is gone, and when the row is not in
 * the collection named — the last one is the engagement boundary, and it is
 * checked here because this is where it is owned. Everything Pro is allowed to
 * copy up is scoped by matchedFilesIn to a collection the writer shared; a bare
 * file id crossing the seam would put that scoping entirely in the closed
 * module's hands, where a stale candidate list, a re-used id after a delete or
 * an off-by-one on a cursor turns into a PDF from a deliberately local
 * collection landing in the agency's library. The boundary is the headline
 * promise of this feature, so it is enforced the same way `heldFile` enforces
 * "held" rather than trusting what it is handed.
 */
export function readFileBytes(collectionId: number, fileId: number): Buffer | null {
  const file = getCollectionFile(fileId);
  if (!file || file.collection_id !== collectionId) return null;
  if (!blobExists(file.content_hash)) return null;
  return fs.readFileSync(blobPath(file.content_hash));
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
 * Returns null when the pull could not be filed: the bytes aren't a PDF, or
 * PubMed couldn't supply the metadata the paper needs to be visible. The PDF
 * check is not a formality — these bytes arrive over the network from another
 * instance, and "a master said so" is not a reason to write arbitrary content
 * into the blob store under a .pdf name. The same check guards ordinary
 * uploads. Anything else that goes wrong throws: null is the caller's "the
 * master sent something unusable", and it should not have to mean "a write
 * failed halfway" as well.
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

  const hash = await storePulledBlob(o.bytes);
  if (hash === null) return null;

  // Sanitised here, at the boundary, not upstream. pullFromMaster does strip a
  // path off the Content-Disposition it parses, and that is not the same thing:
  // this function is a ProContext method, so the name reaching it is whatever
  // *some* build of the Pro module chose to pass. The rule the seam rests on is
  // that the open repo owns the invariants the free tier depends on, and
  // "nothing with a path separator in it is ever written to file_name" is one of
  // them — see safeFileName for what the archive route does with this column.
  const name = safeFileName(o.fileName, `${o.pmid}.pdf`);
  const added = addCollectionFiles(o.collectionId, [{ hash, name }]);
  const file = collectionFileByHash(o.collectionId, hash);
  if (!file) {
    // Not reachable: the insert either added the row or found one already
    // there. Deliberately not `return null` — that is the caller's "the master
    // sent something that isn't a PDF", and answering it here, after the blob
    // and the row are both written, would report the wrong half as the failure.
    throw new Error(`pull: no collection_files row for ${hash} after insert`);
  }

  // Matched by PMID, because that is literally how it was found: the master was
  // asked about this PMID and answered about this PMID.
  //
  // Only for a row this pull actually created, or one nothing has claimed yet.
  // addCollectionFiles is INSERT OR IGNORE against UNIQUE(collection_id,
  // content_hash), so it is a no-op when the collection already holds these
  // bytes — the same PDF uploaded by hand and matched manually, or filed under
  // another name by an earlier pull. Matching unconditionally would overwrite
  // that row's pmid, status and method with the master's claim, and if the two
  // PMIDs differ the paper the user had matched now answers *not held*.
  //
  // One PDF cannot be two papers, so a disagreement here is a real conflict.
  // Leaving the existing match and saying so is the honest outcome; resolving
  // it silently in favour of whoever wrote last is not.
  if (added > 0 || !file.pmid) {
    setFileMatched(file.id, o.pmid, "pmid");
  } else if (file.pmid !== o.pmid) {
    console.warn(
      `[pro] pulled ${o.pmid}, but collection ${o.collectionId} already stores these bytes as ${file.pmid}; keeping the existing match`
    );
  }
  return { fileId: file.id, hash };
}

/**
 * The pulled bytes as a stored blob, or null if they aren't a PDF.
 *
 * Split out so one `finally` owns the temp file for every exit. storeBlobFromTemp
 * renames or unlinks it on each path it *returns* from, but not on the ones it
 * throws from — a hash stream error, or a rename that failed with the blob still
 * absent — and a leaked temp then survives until the next server start sweeps
 * UPLOAD_TMP_DIR.
 */
async function storePulledBlob(bytes: Buffer): Promise<string | null> {
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
  const tmpPath = path.join(UPLOAD_TMP_DIR, `pull-${crypto.randomUUID()}.pdf`);
  try {
    await fs.promises.writeFile(tmpPath, bytes);
    if (!(await isPdfFile(tmpPath))) return null;
    return (await storeBlobFromTemp(tmpPath)).hash;
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
}
