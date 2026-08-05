import { existingBlobHashes } from "./blobstore.js";
import { parseRef, type ParsedRef } from "./citation-ref.js";
import {
  holdingsByDois,
  holdingsByPmids,
  pubTypesByPmids,
  safeParseAuthors,
  type HoldingRow,
} from "./db.js";
import { lookupWorks, type OaWork } from "./openalex.js";
import { evidenceFromRows } from "./pubmed-parse.js";
import type { HaveAnswer, HaveMatch } from "./types.js";

// "Do I already have this?" — the custody question, answered for a list of
// pasted references.
//
// The shape of the work matters more than any one step: **the held/not-held
// verdict is decided entirely locally, before anything touches the network.**
// A writer asking whether the agency already bought a paper must get the same
// answer with the internet down as with it up. OpenAlex is consulted only for
// the lines that came back *not* held, and only to add things that make a
// no more useful — the paper's title, and whether a legal free copy exists.

// A paste bigger than this is chunked by the client (see shared/limits). The
// cap exists because every line is a bound parameter and a URL segment, not
// because more would be wrong — and the response says how many lines one
// request had to drop, so nothing goes missing silently.
export { MAX_REFS_PER_HAVE_REQUEST as MAX_REFS_PER_REQUEST } from "../../shared/limits.js";

export interface HaveOptions {
  /** Ask OpenAlex about the not-held lines. Off makes the check purely local. */
  lookUpFree?: boolean;
}

// A stored row as the API reports it. `present` is one readdir's worth of blob
// hashes, so a list of answers costs one directory read rather than a stat per
// paper (the same trick /papers and /graph use); `pubTypes` is likewise one
// batched query for every paper in the response.
function toMatch(row: HoldingRow, ctx: RenderContext): HaveMatch {
  const { present } = ctx;
  const { types, evidence } = evidenceFromRows(ctx.pubTypes.get(row.pmid) ?? []);
  return {
    evidence,
    pub_types: types,
    pmid: row.pmid,
    title: row.title,
    authors: safeParseAuthors(row.authors),
    journal_name: row.journal_name ?? "",
    pub_date: row.pub_date,
    pub_date_display: row.pub_date_display,
    doi: row.doi,
    url: row.url,
    held: row.file_id != null,
    file_id: row.file_id,
    file_name: row.file_name,
    file_exists: row.content_hash != null && present.has(row.content_hash),
    collection_id: row.collection_id,
    collection_name: row.collection_name,
  };
}

// A paper OpenAlex knows about but the library doesn't hold. Its shape matches
// a held row so the client renders one kind of result card; every
// custody-related field is null or false, which is the whole point of the row.
function fromOpenAlex(work: OaWork): HaveMatch {
  return {
    pmid: work.pmid ?? "",
    title: work.title,
    authors: [],
    journal_name: "",
    pub_date: work.year ? `${work.year}-01-01` : "",
    pub_date_display: work.year ? String(work.year) : "",
    doi: work.doi ?? "",
    url: work.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${work.pmid}/` : work.free?.url || "",
    held: false,
    file_id: null,
    file_name: null,
    file_exists: false,
    collection_id: null,
    collection_name: null,
    // OpenAlex has no equivalent of PublicationTypeList, and this paper isn't
    // held, so nothing local answers it either.
    evidence: "unknown",
    pub_types: [],
  };
}

// What every answer row is rendered against: one readdir of blob hashes and one
// batched publication-type query. Bundled so that adding a lookup doesn't mean a
// sixth positional argument on three functions.
interface RenderContext {
  present: Set<string>;
  pubTypes: Map<string, string[]>;
}

/**
 * Answer one pasted line per input, in the order they were given.
 *
 * Every input yields exactly one answer, including the ones that couldn't be
 * parsed — a paste of thirty references has to come back as thirty rows, or the
 * reader is left comparing two lists to find what went missing.
 */
export async function checkHoldings(
  inputs: string[],
  { lookUpFree = true }: HaveOptions = {}
): Promise<HaveAnswer[]> {
  const refs = inputs.map(parseRef);
  const present = existingBlobHashes();

  // --- local pass: one query per lookup kind, not per reference ---
  const byPmid = new Map<string, HoldingRow>();
  for (const row of holdingsByPmids(refs.flatMap((r) => (r.pmid ? [r.pmid] : [])))) {
    byPmid.set(row.pmid, row);
  }
  const byDoi = new Map<string, HoldingRow>();
  for (const row of holdingsByDois(refs.flatMap((r) => (r.doi ? [r.doi] : [])))) {
    byDoi.set(row.doi.toLowerCase(), row);
  }

  const local = refs.map((ref) => resolveLocally(ref, byPmid, byDoi));

  // Every paper any answer might name.
  const namedPmids = (results: LocalResult[]) =>
    results.flatMap((r) => (r.row ? [r.row.pmid] : []));

  // Publication types for all of them in one query, rather than one per row.
  const renderContext = (pmids: string[]): RenderContext => ({
    present,
    pubTypes: pubTypesByPmids(pmids),
  });

  // --- enrichment pass: only the lines that came back not held ---
  //
  // Two things are being asked at once, which is why this is worth a request:
  // is there a free copy, and — for a DOI we couldn't place — does it resolve
  // to a PMID we *do* hold? The second is a genuine second chance at a "yes",
  // since a DOI can be absent or differently cased on an article record whose
  // PMID we have.
  const needsLookup = new Set(
    local.filter((r) => !r.held && (r.ref.kind === "doi" || r.ref.kind === "pmid"))
  );
  if (!lookUpFree || needsLookup.size === 0) {
    // Hoisted: inside the map this rebuilt the whole context — a flatMap over
    // every result plus a batched publication-type query — once per answer row.
    const ctx = renderContext(namedPmids(local));
    return local.map((r) => toAnswer(r, ctx, false, null));
  }

  const pending = [...needsLookup];
  const { byDoi: oaByDoi, byPmid: oaByPmid } = await lookupWorks(
    pending.flatMap((r) => (r.ref.doi ? [r.ref.doi] : [])),
    pending.flatMap((r) => (r.ref.pmid ? [r.ref.pmid] : []))
  );

  // A DOI that OpenAlex resolved to a PMID gets one more look at the library.
  const resolvedPmids = pending.flatMap((r) => {
    const work = r.ref.doi ? oaByDoi.get(r.ref.doi) : undefined;
    return work?.pmid ? [work.pmid] : [];
  });
  const secondLook = new Map<string, HoldingRow>();
  for (const row of holdingsByPmids(resolvedPmids)) secondLook.set(row.pmid, row);

  // Built here rather than above so it also covers the papers the second look
  // just turned up — those are held, so they're exactly the rows whose
  // publication types a reader will want.
  const ctx = renderContext([...namedPmids(local), ...secondLook.keys()]);

  return local.map((r) => {
    if (!needsLookup.has(r)) return toAnswer(r, ctx, false, null);
    const work = (r.ref.doi ? oaByDoi.get(r.ref.doi) : null) ?? (r.ref.pmid ? oaByPmid.get(r.ref.pmid) : null) ?? null;
    const rediscovered = work?.pmid ? secondLook.get(work.pmid) : undefined;
    if (rediscovered && rediscovered.file_id != null) {
      // Held after all — under a PMID the pasted DOI didn't reach directly. No
      // free-copy answer is offered here: it's moot, and offering one would
      // invite buying a paper already on disk.
      return toAnswer({ ...r, row: rediscovered, held: true }, ctx, false, null);
    }
    // Still not held. Prefer whatever the library already knows about the paper
    // over OpenAlex's thinner record — a cached article row carries authors,
    // journal and the exact publication date.
    const enriched = r.row ?? rediscovered ?? null;
    return toAnswer({ ...r, row: enriched, oa: work }, ctx, true, work?.free ?? null);
  });
}

// The intermediate result of the local pass: what the line parsed to, and
// whatever the library could say about it without leaving the machine.
interface LocalResult {
  ref: ParsedRef;
  row: HoldingRow | null; // the paper the identifier named, when it's on file
  held: boolean;
  oa?: OaWork | null;
}

function resolveLocally(
  ref: ParsedRef,
  byPmid: Map<string, HoldingRow>,
  byDoi: Map<string, HoldingRow>
): LocalResult {
  const empty: LocalResult = { ref, row: null, held: false };
  if (ref.kind === "pmid" && ref.pmid) {
    const row = byPmid.get(ref.pmid) ?? null;
    return { ...empty, row, held: row?.file_id != null };
  }
  if (ref.kind === "doi" && ref.doi) {
    const row = byDoi.get(ref.doi) ?? null;
    return { ...empty, row, held: row?.file_id != null };
  }
  return empty;
}

function toAnswer(
  r: LocalResult,
  ctx: RenderContext,
  freeChecked: boolean,
  free: HaveAnswer["free"]
): HaveAnswer {
  return {
    parsed: r.ref,
    held: r.held,
    match: r.row ? toMatch(r.row, ctx) : r.oa ? fromOpenAlex(r.oa) : null,
    free,
    freeChecked,
  };
}
