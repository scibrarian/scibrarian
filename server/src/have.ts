import { existingBlobHashes } from "./blobstore.js";
import { parseRef, type ParsedRef } from "./citation-ref.js";
import {
  getSetting,
  heldByAuthorYear,
  holdingsByDois,
  holdingsByPmids,
  safeParseAuthors,
  type HoldingRow,
} from "./db.js";
import { lookupWorks, type OaWork } from "./openalex.js";
import type { CiteStatus, HaveAnswer, HaveMatch } from "./types.js";

// "Do I already have this?" — the custody question, answered for a list of
// pasted references.
//
// The shape of the work matters more than any one step: **the held/not-held
// verdict is decided entirely locally, before anything touches the network.**
// A writer asking whether the agency already bought a paper must get the same
// answer with the internet down as with it up. OpenAlex is consulted only for
// the lines that came back *not* held, and only to add things that make a
// no more useful — the paper's title, and whether a legal free copy exists.
//
// The three-state answer the roadmap asks for is composed from two orthogonal
// facts rather than one enum: `held`, and `cite` (see CiteStatus). They are
// kept apart because citability applies to papers the library doesn't hold too
// — a writer about to buy a paper that's already outside the window wants to
// know that before the purchase, not after.

// A paste bigger than this is chunked by the client (see shared/limits). The
// cap exists because every line is a bound parameter and a URL segment, not
// because more would be wrong — and the response says how many lines one
// request had to drop, so nothing goes missing silently.
export { MAX_REFS_PER_HAVE_REQUEST as MAX_REFS_PER_REQUEST } from "../../shared/limits.js";

export interface HaveOptions {
  /** Ask OpenAlex about the not-held lines. Off makes the check purely local. */
  lookUpFree?: boolean;
}

// The citable window, in years. 0 (or an unparseable setting) means the
// judgement is switched off and every answer's `cite` is "unknown".
export function citationWindowYears(): number {
  const n = Number(getSetting("citation_window_years"));
  return Number.isInteger(n) && n > 0 && n <= 100 ? n : 0;
}

// Publication year from the stored sortable date ('' when PubMed gave none).
function yearOf(pubDate: string): number | null {
  const m = /^(\d{4})/.exec(pubDate);
  return m ? Number(m[1]) : null;
}

// Whether a paper is recent enough to cite.
//
// Compared at year granularity, not by exact date. Two reasons: the rule is
// stated in years ("nothing older than five"), and pub_date is padded to
// January 1st when PubMed reports only a year — so a date comparison would
// invent precision the stored value doesn't have and age papers out months
// early. Erring toward "still citable" is the right direction: the writer
// checks the exact date on a borderline paper anyway, whereas a wrongly
// flagged reference is one they just don't use.
export function citeStatus(year: number | null, windowYears: number): CiteStatus {
  if (windowYears <= 0 || year == null) return "unknown";
  return year >= new Date().getFullYear() - windowYears ? "citable" : "out_of_window";
}

// A stored row as the API reports it. `present` is one readdir's worth of blob
// hashes, so a list of answers costs one directory read rather than a stat per
// paper (the same trick /papers and /graph use).
function toMatch(row: HoldingRow, present: Set<string>, windowYears: number): HaveMatch {
  const year = yearOf(row.pub_date);
  return {
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
    cite: citeStatus(year, windowYears),
    year,
  };
}

// A paper OpenAlex knows about but the library doesn't hold. Its shape matches
// a held row so the client renders one kind of result card; every
// custody-related field is null or false, which is the whole point of the row.
function fromOpenAlex(work: OaWork, windowYears: number): HaveMatch {
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
    cite: citeStatus(work.year, windowYears),
    year: work.year,
  };
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
  const windowYears = citationWindowYears();
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

  // Citation strings can't be batched — each is its own surname/year pair — but
  // they're a small, bounded set (at most MAX_REFS_PER_REQUEST) and each query
  // is a single indexed scan of the held papers.
  const candidatesByInput = new Map<string, HoldingRow[]>();
  for (const ref of refs) {
    if (ref.kind !== "citation" || !ref.authorKey || ref.year == null) continue;
    candidatesByInput.set(ref.input, heldByAuthorYear(ref.authorKey, ref.year));
  }

  const local = refs.map((ref) => resolveLocally(ref, byPmid, byDoi, candidatesByInput));

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
    return local.map((r) => toAnswer(r, present, windowYears, false, null));
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

  return local.map((r) => {
    if (!needsLookup.has(r)) return toAnswer(r, present, windowYears, false, null);
    const work = (r.ref.doi ? oaByDoi.get(r.ref.doi) : null) ?? (r.ref.pmid ? oaByPmid.get(r.ref.pmid) : null) ?? null;
    const rediscovered = work?.pmid ? secondLook.get(work.pmid) : undefined;
    if (rediscovered && rediscovered.file_id != null) {
      // Held after all — under a PMID the pasted DOI didn't reach directly. No
      // free-copy answer is offered here: it's moot, and offering one would
      // invite buying a paper already on disk.
      return toAnswer({ ...r, row: rediscovered, held: true }, present, windowYears, false, null);
    }
    // Still not held. Prefer whatever the library already knows about the paper
    // over OpenAlex's thinner record — a cached article row carries authors,
    // journal and the exact publication date.
    const enriched = r.row ?? rediscovered ?? null;
    return toAnswer(
      { ...r, row: enriched, oa: work },
      present,
      windowYears,
      true,
      work?.free ?? null
    );
  });
}

// The intermediate result of the local pass: what the line parsed to, and
// whatever the library could say about it without leaving the machine.
interface LocalResult {
  ref: ParsedRef;
  row: HoldingRow | null; // the one paper, when exactly one was identified
  rows: HoldingRow[]; // several held candidates from an author+year search
  held: boolean;
  oa?: OaWork | null;
}

function resolveLocally(
  ref: ParsedRef,
  byPmid: Map<string, HoldingRow>,
  byDoi: Map<string, HoldingRow>,
  candidatesByInput: Map<string, HoldingRow[]>
): LocalResult {
  const empty: LocalResult = { ref, row: null, rows: [], held: false };
  if (ref.kind === "pmid" && ref.pmid) {
    const row = byPmid.get(ref.pmid) ?? null;
    return { ...empty, row, held: row?.file_id != null };
  }
  if (ref.kind === "doi" && ref.doi) {
    const row = byDoi.get(ref.doi) ?? null;
    return { ...empty, row, held: row?.file_id != null };
  }
  if (ref.kind === "citation") {
    const rows = candidatesByInput.get(ref.input) ?? [];
    // One hit is an answer; several are a question for the reader. A citation
    // string names an author and a year, and a library can legitimately hold
    // two papers matching both — picking one would put a writer in front of the
    // wrong PDF while telling them it's the right one.
    if (rows.length === 1) return { ...empty, row: rows[0], held: true };
    return { ...empty, rows, held: rows.length > 0 };
  }
  return empty;
}

function toAnswer(
  r: LocalResult,
  present: Set<string>,
  windowYears: number,
  freeChecked: boolean,
  free: HaveAnswer["free"]
): HaveAnswer {
  const { authorKey, ...parsed } = r.ref; // authorKey is an internal match key
  const match = r.row
    ? toMatch(r.row, present, windowYears)
    : r.oa
      ? fromOpenAlex(r.oa, windowYears)
      : null;
  return {
    parsed,
    held: r.held,
    match: r.rows.length > 1 ? null : match,
    candidates: r.rows.length > 1 ? r.rows.map((row) => toMatch(row, present, windowYears)) : [],
    free,
    freeChecked,
  };
}
