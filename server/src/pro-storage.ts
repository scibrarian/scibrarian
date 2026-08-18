import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UPLOAD_TMP_DIR } from "./config.js";
import { blobExists, blobPath, isPdfFile, safeFileName, storeBlobFromTemp } from "./blobstore.js";
import {
  addCollectionFiles,
  collectionFileByHash,
  collectionFilesMatchedByEvidence,
  collectionManualMatchCount,
  createCollection,
  existingPmids,
  getCollection,
  getCollectionFile,
  holdingsByPmids,
  setFileMatched,
  upsertArticles,
} from "./db.js";
import { fetchArticles } from "./pubmed.js";
import { errMessage } from "./util.js";

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
 * Files in a collection that are matched to a paper **by evidence**.
 *
 * The push candidates. Filtered here rather than at the call site because the
 * reasons are invariants of this schema, not of the Pro module.
 *
 * `matched`, because identity between instances is the PMID, and a file without
 * one cannot be filed by whoever receives it.
 *
 * And **never a manual match**, which is the narrower and more important rule.
 * A `pmid` or `doi` match was derived from the document's own text, so there is
 * evidence the file is what it claims. A manual one is a person asserting it:
 * the route validates that the PMID exists in PubMed and cannot check that the
 * PDF is that paper. Locally that is a fair trade — the writer made the claim
 * and lives with it. Across the seam it is not, because a copy leaves the
 * machine and one person's mistake becomes the whole organisation's: the agency
 * then holds bytes filed under a PMID they may not be, and the next writer who
 * asks "do we have this?" is told yes, skips the purchase, and opens the wrong
 * paper. That is the failure this product exists to prevent, arrived at from
 * the other side.
 *
 * Silent exclusion would be its own bug, so it is counted and reported — see
 * manualMatchCountIn and the sweep result that carries it.
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
  return collectionFilesMatchedByEvidence(collectionId).map((f) => ({
    id: f.id,
    collection_id: collectionId,
    pmid: f.pmid,
    file_name: safeFileName(f.file_name, `${f.pmid}.pdf`),
  }));
}

/**
 * How many files in a collection are held back for being matched by hand.
 *
 * A count, never the rows. The whole point of excluding them from
 * matchedFilesIn is that their ids never reach the side of the seam that sends
 * files, so handing them over here — even to be counted — would put them back
 * within reach of a module that only meant to tally them.
 *
 * It exists because an exclusion nobody can see is worse than the risk it
 * avoids. `match_method` is surfaced nowhere in the UI, so without this a
 * writer's genuine contributions would silently never arrive, and the master's
 * "pulled 12 · uploaded 0" line — the one number a project manager acts on —
 * would accuse people who had in fact contributed.
 */
export function manualMatchCountIn(collectionId: number): number {
  return collectionManualMatchCount(collectionId);
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

/**
 * A new collection — always an insert, never an adoption.
 *
 * The only way Pro creates one. A find-or-create counterpart used to sit beside
 * this, on the reasoning that a name is the right identity when it is specific
 * to what is being filed — an organisation's own collection on a spoke. It
 * wasn't: an organisation's display name is self-declared and unvalidated, so
 * two of them sharing one shared a collection, and the pull that adopted it
 * re-pointed that collection at whichever had been pulled from last. Nothing
 * files by name any more.
 *
 * **Throws when the name is taken.** `collections.name` carries a unique index,
 * COLLATE NOCASE, so "from writers" and "From Writers" collide. That is a real
 * outcome a caller has to answer for, not a theoretical one: the master's inbox
 * is named for a role rather than a party, so an owner may well have used it.
 */
export function newCollection(name: string): number {
  return createCollection(name).id;
}

/** Whether a collection id still resolves. For a caller holding a remembered id. */
export function collectionExists(id: number): boolean {
  return getCollection(id) != null;
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

/** One collection the pull was filed into, and the row it produced there. */
export interface FiledCopy {
  collectionId: number;
  fileId: number;
  /**
   * Whether the row on this shelf answers as the PMID that was pulled.
   *
   * False in exactly one case: the collection already held these exact bytes
   * under a *different* match — typically the user's own manual one, which is
   * deliberately never overwritten. The bytes are on the shelf either way, but
   * the paper that was asked for is not retrievable from it, and nothing may
   * claim the organisation supplied a paper this row is not matched to.
   */
  matchedToPull: boolean;
  /** What the row is matched to instead. Set only when matchedToPull is false. */
  matchedTo?: string;
}

export interface PulledFile {
  hash: string;
  /** Collections the copy reached. Empty only if every one of them failed. */
  filed: FiledCopy[];
  /** Collections it did not reach, and why. Normally empty. */
  failed: { collectionId: number; error: string }[];
}

/**
 * File bytes pulled from a master as a genuinely held paper, onto one or more
 * shelves.
 *
 * Returns null when the pull could not be filed at all: the bytes aren't a PDF,
 * or PubMed couldn't supply the metadata the paper needs to be visible. The PDF
 * check is not a formality — these bytes arrive over the network from another
 * instance, and "a master said so" is not a reason to write arbitrary content
 * into the blob store under a .pdf name. The same check guards ordinary
 * uploads.
 *
 * The sequence is the reason this lives here: metadata, then blob, then the
 * rows, then the matches. Metadata first so a PubMed outage fails the pull with
 * nothing written, rather than leaving bytes on disk the library can't see. A
 * row written before its blob points at nothing; a blob written with no row is
 * invisible and would be GC'd. storeBlobFromTemp is idempotent on content, so
 * pulling a paper the library already stores under a different name costs one
 * row and no bytes.
 *
 * **Takes every destination at once, and that is the whole reason for the
 * shape.** Both checks above are properties of the *bytes* — whether they are a
 * PDF, and whether their PMID resolves — so asking them per collection asks the
 * same question repeatedly and can only ever get the same answer. Called in a
 * loop it was worse than redundant: each call wrote the entire buffer to a
 * fresh temp file, sniffed it, and streamed it through SHA-256 before
 * discovering the blob was already stored. Five shelves for one 40 MB pull
 * meant 200 MB written and 200 MB hashed to add four rows.
 *
 * **Per-collection failures are reported, not rolled back.** A copy that
 * reached one shelf is on disk and its row is valid; unwinding it so the answer
 * can be all-or-nothing would destroy a correct write to tell a tidier story.
 * There is no outer transaction to lean on either — addCollectionFiles brings
 * its own, and SQLite does not nest them. So each shelf is filed independently
 * and the caller is told exactly which ones took the copy.
 */
export async function storePulledFile(o: {
  bytes: Buffer;
  fileName: string;
  pmid: string;
  collectionIds: number[];
}): Promise<PulledFile | null> {
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

  const filed: FiledCopy[] = [];
  const failed: PulledFile["failed"] = [];
  // De-duplicated: the same shelf named twice is one shelf, and filing it twice
  // would report two copies of a row that UNIQUE(collection_id, content_hash)
  // only ever allows one of.
  for (const collectionId of new Set(o.collectionIds)) {
    try {
      filed.push({ collectionId, ...fileOnShelf(collectionId, hash, name, o.pmid) });
    } catch (err) {
      failed.push({ collectionId, error: errMessage(err) });
    }
  }
  return { hash, filed, failed };
}

/**
 * Put one already-stored blob on one shelf, and match it if nothing else has.
 *
 * The per-collection half of a pull, split out so the byte-level work above it
 * happens once however many shelves were chosen.
 *
 * Reports whether the row it settled on answers as `pmid`. The branch was
 * already computed here and thrown away, and the caller needs it for two
 * decisions it cannot make otherwise: whether the organisation may be recorded
 * as having supplied this paper, and whether to tell the writer that the shelf
 * they picked holds these bytes as something else entirely.
 */
function fileOnShelf(
  collectionId: number,
  hash: string,
  name: string,
  pmid: string
): Omit<FiledCopy, "collectionId"> {
  const added = addCollectionFiles(collectionId, [{ hash, name }]);
  const file = collectionFileByHash(collectionId, hash);
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
    setFileMatched(file.id, pmid, "pmid");
    return { fileId: file.id, matchedToPull: true };
  }
  if (file.pmid !== pmid) {
    console.warn(
      `[pro] pulled ${pmid}, but collection ${collectionId} already stores these bytes as ${file.pmid}; keeping the existing match`
    );
    return { fileId: file.id, matchedToPull: false, matchedTo: file.pmid };
  }
  // Already matched to the paper that was pulled — an earlier pull, or the user
  // reaching the same conclusion by hand. Nothing to change, and no conflict:
  // the organisation did supply these bytes and the row does answer as this
  // paper, which is the "additive, not exclusive" case the schema describes.
  return { fileId: file.id, matchedToPull: true };
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
