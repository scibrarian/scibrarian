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
import { heldElsewhere } from "./elsewhere.js";
import { orgCheck, proActive } from "./pro-hooks.js";
import { workspacesEnabled } from "./workspaces.js";
import { evidenceFromRows } from "./pubmed-parse.js";
import type { OrgHolding } from "../../shared/pro.js";
import type { ElsewhereHolding } from "../../shared/types.js";
import type { HaveAnswer, HaveMatch } from "./types.js";

// "Do I already have this?" — the custody question, answered for a list of
// pasted references.
//
// The shape of the work matters more than any one step: **the held/not-held
// verdict is decided entirely locally, before anything touches the network.**
// A writer asking whether the agency already bought a paper must get the same
// answer with the internet down as with it up. OpenAlex is consulted only for
// the lines that came back *not* held, and only to add things that make a
// no more useful — the paper's title, and the PMID a pasted DOI didn't carry.

// A paste bigger than this is chunked by the client (see shared/limits). The
// cap exists because every line is a bound parameter and a URL segment, not
// because more would be wrong — and the response says how many lines one
// request had to drop, so nothing goes missing silently.
export { MAX_REFS_PER_HAVE_REQUEST as MAX_REFS_PER_REQUEST } from "../../shared/limits.js";

export interface HaveOptions {
  /** Ask OpenAlex about the not-held lines, to resolve identifiers it can. */
  lookUpIdentifiers?: boolean;
  /** Ask the paired master about the not-held lines (Pro; no-op in a free build). */
  checkOrg?: boolean;
  /**
   * Whether an elsewhere hit may say *which* workspace and collection.
   *
   * Off unless the caller asks for it, because the caller that matters is a
   * public GET. The verdict — you already own this — is what the check is for
   * and goes to everyone; the names are the agencies this person works for,
   * which is what GET /workspaces is admin-gated to protect. Defaulting to off
   * means a route added later leaks nothing by forgetting.
   */
  nameWorkspaces?: boolean;
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
    // PubMed when there is a PMID, the DOI resolver otherwise. This used to
    // fall back to the free copy's URL, which is gone; doi.org is the link that
    // is always right for a paper identified by its DOI.
    url: work.pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${work.pmid}/`
      : work.doi
        ? `https://doi.org/${work.doi}`
        : "",
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
  { lookUpIdentifiers = true, checkOrg = true, nameWorkspaces = false }: HaveOptions = {}
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

  // Whether a check that could have answered this row did — see verdictComplete.
  //
  // The applicability half is the part only this side can know. Both flags read
  // false on a deployment where their check does not exist at all:
  // workspacesEnabled() is false on every hosted instance and proActive() in
  // every free build, and the absence is trustworthy in both. Collapsing that
  // into "a check failed" would put a warning on every row of every free build.
  //
  // An explicit opt-out is not a failure either. checkOrg is false for the
  // local-only answer the client asks for while a paste is still being typed,
  // and flagging every row of a preview would train a reader to ignore the one
  // that matters. The lookup it skipped is reported by identifierChecked.
  const elsewhereApplies = workspacesEnabled();
  const orgApplies = checkOrg && proActive();
  const complete = (r: LocalResult): boolean =>
    (!elsewhereApplies || r.elsewhereChecked === true) &&
    (!orgApplies || r.orgChecked === true);

  // --- other-workspace pass: the fourth verdict, already yours, filed elsewhere ---
  //
  // Ahead of the org pass because it is local: no request, no network, and the
  // same answer with the machine offline. It belongs with the local pass in
  // every way except that it cannot set `held`, which stays a statement about
  // *this* workspace — the file is in another database's blob store and this
  // session has no route to it.
  //
  // Additive and nothing more. It suppresses neither the org check nor the
  // identifier lookup, unlike an org hit which suppresses the second: an org hit
  // offers a way to *get* the paper, and this one offers a way to stop paying
  // for it. A writer told "you own this in Acme" is still better off knowing
  // the org has a copy they can pull.
  applyElsewhere(
    local.filter((r) => !r.held),
    orgKey,
    nameWorkspaces
  );

  // --- org pass: the third verdict, held by your org but not by you ---
  //
  // Ordered between the local pass and OpenAlex on purpose. An org hit answers
  // the line outright — the same reasoning that suppresses the lookup for a
  // paper rediscovered on disk below — so asking the master first also shrinks
  // what has to leave for OpenAlex.
  //
  // Identity is the PMID and only the PMID. A registry keyed on anything softer
  // produces near-miss rows and false "someone has it" answers, which is the
  // one answer this must never get wrong. A not-held line with no PMID at all
  // is simply not asked about.
  //
  // Nothing here can change `held`: that verdict was decided above, locally,
  // before anything touched the network, and it stays the same answer with the
  // master down as with it up. The org line is strictly an addition.
  if (checkOrg) {
    const candidates = local.filter((r) => !r.held);
    const orgPmids = candidates.flatMap((r) => {
      const pmid = orgKey(r);
      return pmid ? [pmid] : [];
    });
    const holdings = await orgCheck(orgPmids);
    // null means no Pro module *or* an unreachable master, and the two collapse
    // deliberately: both are "nobody answered", which orgChecked reports as
    // such rather than as a no.
    if (holdings) {
      for (const r of candidates) {
        // A line carrying no identifier was never in the batch, so it wasn't
        // answered either. Marking it checked would be harmless today — the UI
        // has no org line to draw on an unreadable row — but the field would
        // stop meaning what it says, and it is the field that stands between
        // "the org doesn't have it" and "nobody asked".
        const pmid = orgKey(r);
        if (!pmid) continue;
        r.orgChecked = true;
        r.org = holdings.get(pmid) ?? null;
      }
    }
  }

  // --- enrichment pass: only the lines that came back not held ---
  //
  // What is asked here: for a DOI we couldn't place, does it resolve to a PMID
  // we *do* hold? A genuine second chance at a "yes", since a DOI can be absent
  // or differently cased on an article record whose PMID we have — and the PMID
  // it supplies is what the second org and other-workspace passes ask under,
  // which is the only route those two have to a line that arrived as a DOI.
  //
  // Lines the org holds are excluded: they already have their answer, and
  // resolving an identifier for a row about to read "held by your organization"
  // spends a request on nothing.
  const needsLookup = new Set(
    local.filter((r) => !r.held && !r.org && (r.ref.kind === "doi" || r.ref.kind === "pmid"))
  );
  if (!lookUpIdentifiers || needsLookup.size === 0) {
    // Hoisted: inside the map this rebuilt the whole context — a flatMap over
    // every result plus a batched publication-type query — once per answer row.
    const ctx = renderContext(namedPmids(local));
    return local.map((r) => toAnswer(r, ctx, { identifier: false, complete: complete(r) }));
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

  // The PMID OpenAlex supplied for a line that had none. Both second passes
  // below are about exactly these lines, and both need the same key.
  const oaPmid = (r: LocalResult): string =>
    (r.ref.doi ? oaByDoi.get(r.ref.doi)?.pmid : undefined) ?? "";

  // --- second other-workspace pass: the same gap, closed the same way ---
  //
  // The reason is identical to the second org pass below, so read that one
  // first. A pasted DOI for a paper *this* workspace has never seen carries no
  // PMID through the first pass — orgKey finds none on the row, because there
  // is no row — so the union was never asked about it. OpenAlex has now
  // supplied one.
  //
  // Left out, this is the case that re-buys: a writer in Bristol's workspace
  // pastes a DOI for a paper sitting in their Acme workspace, and because the
  // Bristol database has no article record to hang a PMID on, they are told
  // "not in your library" about a PDF already on their own disk. Every other
  // route into this check has a PMID by the time the first pass runs; this one
  // structurally cannot.
  applyElsewhere(
    pending.filter((r) => !r.elsewhereChecked && secondLook.get(oaPmid(r))?.file_id == null),
    oaPmid,
    nameWorkspaces
  );

  // --- second org pass: the lines OpenAlex just gave a PMID to ---
  //
  // A pasted DOI naming a paper this library has never seen has no PMID when
  // the first pass runs: orgKey finds nothing on the row (there is no row) and
  // nothing on the ref, so the line is not in that batch. OpenAlex has now
  // supplied one, and without asking again the writer is told "not in your
  // library" for a paper the agency already bought. That is the false negative
  // this whole feature exists to prevent, reached by the one route the first
  // pass structurally cannot cover.
  //
  // Kept as a second ask rather than by moving the first pass after OpenAlex:
  // an org hit suppresses the identifier lookup, and that only shrinks anything
  // if the org is asked first. This covers the remainder — the lines that had
  // no PMID to ask about — and asks about nothing the first pass already did.
  if (checkOrg) {
    // Rows the second look found on disk are held now, and a held row never
    // shows an org line — asking about them would spend the request on an
    // answer nothing renders.
    const late = pending.filter(
      (r) => !r.orgChecked && oaPmid(r) && secondLook.get(oaPmid(r))?.file_id == null
    );
    const holdings = await orgCheck(late.map(oaPmid));
    if (holdings) {
      for (const r of late) {
        r.orgChecked = true;
        r.org = holdings.get(oaPmid(r)) ?? null;
      }
    }
  }

  // Built here rather than above so it also covers the papers the second look
  // just turned up — those are held, so they're exactly the rows whose
  // publication types a reader will want.
  const ctx = renderContext([...namedPmids(local), ...secondLook.keys()]);

  return local.map((r) => {
    if (!needsLookup.has(r)) return toAnswer(r, ctx, { identifier: false, complete: complete(r) });
    const work = (r.ref.doi ? oaByDoi.get(r.ref.doi) : null) ?? (r.ref.pmid ? oaByPmid.get(r.ref.pmid) : null) ?? null;
    const rediscovered = work?.pmid ? secondLook.get(work.pmid) : undefined;
    if (rediscovered && rediscovered.file_id != null) {
      // Held after all — under a PMID the pasted DOI didn't reach directly.
      return toAnswer({ ...r, row: rediscovered, held: true }, ctx, {
        identifier: false,
        complete: complete(r),
      });
    }
    // Still not held. Prefer whatever the library already knows about the paper
    // over OpenAlex's thinner record — a cached article row carries authors,
    // journal and the exact publication date.
    const enriched = r.row ?? rediscovered ?? null;
    return toAnswer({ ...r, row: enriched, oa: work }, ctx, {
      identifier: true,
      complete: complete(r),
    });
  });
}

// The intermediate result of the local pass: what the line parsed to, and
// whatever the library could say about it without leaving the machine.
interface LocalResult {
  ref: ParsedRef;
  row: HoldingRow | null; // the paper the identifier named, when it's on file
  held: boolean;
  oa?: OaWork | null;
  org?: OrgHolding | null;
  orgChecked?: boolean;
  elsewhere?: ElsewhereHolding | null;
  elsewhereChecked?: boolean;
}

/**
 * Ask the other workspaces about these lines, and record what they said.
 *
 * `keyOf` is the PMID to ask under, which differs between the two calls: the
 * first uses orgKey (the article row's id, or the pasted one), the second the
 * id OpenAlex supplied for a line that had neither.
 *
 * A hit is recorded whatever `checked` says — it was read out of a database on
 * this machine and is true regardless of what some other workspace failed to
 * answer. Only the *absence* depends on a complete answer, which is what
 * `elsewhereChecked` reports, and it is set only for lines actually in the
 * batch: a line with no identifier was never asked about, and marking it
 * checked would make the field mean something other than what it says. Same
 * rule the org pass follows, for the same reason.
 */
function applyElsewhere(
  candidates: LocalResult[],
  keyOf: (r: LocalResult) => string,
  withNames: boolean
): void {
  const pmids = candidates.flatMap((r) => {
    const pmid = keyOf(r);
    return pmid ? [pmid] : [];
  });
  if (pmids.length === 0) return;
  const { holdings, checked } = heldElsewhere(pmids);
  for (const r of candidates) {
    const pmid = keyOf(r);
    if (!pmid) continue;
    if (checked) r.elsewhereChecked = true;
    const hit = holdings.get(pmid);
    // The hit itself is the answer that stops the purchase, and it goes to
    // every caller. Where it is found is withheld from the ones that could not
    // have read it from GET /workspaces — see nameWorkspaces.
    if (hit) r.elsewhere = withNames ? hit : { workspace: null, collection: null };
  }
}

// The PMID an org lookup would use for this line. A cached article row is
// preferred over the pasted identifier because a line carrying only a DOI can
// still name a paper whose PMID the library knows.
function orgKey(r: LocalResult): string {
  return r.row?.pmid ?? r.ref.pmid ?? "";
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

// What ran for a row, as the answer reports it. An object rather than two more
// positional booleans: adjacent boolean arguments are one transposition away
// from a wrong answer, and both of these exist to stop the row claiming more
// certainty than there is.
interface Checked {
  /** The online identifier lookup ran for this row. */
  identifier: boolean;
  /** Every check that applies to this deployment answered. */
  complete: boolean;
}

function toAnswer(r: LocalResult, ctx: RenderContext, checked: Checked): HaveAnswer {
  return {
    parsed: r.ref,
    held: r.held,
    match: r.row ? toMatch(r.row, ctx) : r.oa ? fromOpenAlex(r.oa) : null,
    identifierChecked: checked.identifier,
    verdictComplete: checked.complete,
    org: r.org ?? null,
    orgChecked: r.orgChecked ?? false,
    elsewhere: r.elsewhere ?? null,
    elsewhereChecked: r.elsewhereChecked ?? false,
  };
}
