import { getSetting } from "./db.js";
import { fetchWithTimeout } from "./http.js";
import { errMessage } from "./util.js";
import type { FreeCopy } from "./types.js";

// OpenAlex work lookup, for the half of "do I already have this?" that saves
// money rather than time: when the library doesn't hold a paper, is there a
// legal free copy before anyone buys one?
//
// OpenAlex rather than Unpaywall because one request answers three questions at
// once — the open-access location, the paper's identity (title, year), and the
// PMID for a work we only had a DOI for. That last one matters: a DOI we can't
// find locally may still be a paper we hold under its PMID, so resolving it
// here gives the holdings check a second, better-informed look.
//
// This is also the first use of the OpenAlex *works* API in the codebase
// (journal-catalog.ts uses /sources for journal metrics). The roadmap's
// iCite → OpenAlex move would build on this endpoint; nothing here presumes it.
const OPENALEX_WORKS = "https://api.openalex.org/works";

// Only what the check reads. Asking for the whole work record would pull
// abstracts and full authorship lists for papers nobody has decided to buy yet.
const SELECT = "ids,title,publication_year,open_access,best_oa_location";

// OpenAlex allows up to 200 per page; 50 keeps the filter URL comfortably short
// (DOIs are long) and matches the cap journal-catalog.ts uses.
const BATCH = 50;

export interface OaWork {
  pmid: string | null;
  doi: string | null; // bare and lowercased, matching how DOIs are stored here
  title: string;
  year: number | null;
  free: FreeCopy | null;
}

interface OaLocation {
  pdf_url?: string | null;
  landing_page_url?: string | null;
  license?: string | null;
  version?: string | null;
  source?: { display_name?: string | null } | null;
}

interface OaResult {
  ids?: { doi?: string; pmid?: string };
  title?: string | null;
  publication_year?: number | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  best_oa_location?: OaLocation | null;
}

// OpenAlex returns ids as URLs ("https://doi.org/10.1/x",
// "https://pubmed.ncbi.nlm.nih.gov/12345678"); everything here keys on the bare
// form.
function bareDoi(id: string | undefined): string | null {
  if (!id) return null;
  const m = /10\.\d{4,9}\/\S+/.exec(id);
  return m ? m[0].toLowerCase() : null;
}

function barePmid(id: string | undefined): string | null {
  if (!id) return null;
  const m = /(\d{1,8})\s*$/.exec(id.replace(/\/+$/, ""));
  return m ? m[1] : null;
}

// The free copy, if OpenAlex says there is one.
//
// A PDF link is preferred over a landing page because the point is to read the
// paper now, but a landing page is still an answer — some repositories only
// expose one, and "here is where it's hosted" beats "no". `open_access.oa_url`
// is the last resort: it is set on works whose best location OpenAlex hasn't
// resolved to a record.
function toFreeCopy(r: OaResult): FreeCopy | null {
  const loc = r.best_oa_location;
  const url = loc?.pdf_url || loc?.landing_page_url || r.open_access?.oa_url || null;
  if (!url) return null;
  return {
    url,
    license: loc?.license ?? null,
    version: loc?.version ?? null,
    source: loc?.source?.display_name ?? null,
  };
}

async function fetchFiltered(filter: string): Promise<OaResult[]> {
  // OpenAlex "polite pool": include the configured contact email when set, the
  // same courtesy journal-catalog.ts extends.
  const mailto = getSetting("ncbi_email");
  const url =
    `${OPENALEX_WORKS}?filter=${encodeURIComponent(filter)}` +
    `&select=${SELECT}&per-page=${BATCH}` +
    (mailto ? `&mailto=${encodeURIComponent(mailto)}` : "");
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`OpenAlex returned ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { results?: OaResult[] };
  return data.results ?? [];
}

// Look up works by DOI and/or PMID. Returns two maps keyed the way the caller
// asked, because a work found by DOI has to be findable again by the DOI that
// was typed, not only by the one OpenAlex normalized it to.
//
// Best-effort throughout: a failure returns whatever was already collected. The
// holdings answer is local and authoritative, and must not turn into an error
// because a third party was unreachable — "we couldn't check for a free copy"
// is a degraded answer, not a broken one, and the response says which it is.
export async function lookupWorks(
  dois: string[],
  pmids: string[]
): Promise<{ byDoi: Map<string, OaWork>; byPmid: Map<string, OaWork> }> {
  const byDoi = new Map<string, OaWork>();
  const byPmid = new Map<string, OaWork>();

  const collect = (results: OaResult[]) => {
    for (const r of results) {
      const work: OaWork = {
        pmid: barePmid(r.ids?.pmid),
        doi: bareDoi(r.ids?.doi),
        title: r.title ?? "",
        year: typeof r.publication_year === "number" ? r.publication_year : null,
        free: toFreeCopy(r),
      };
      if (work.doi) byDoi.set(work.doi, work);
      if (work.pmid) byPmid.set(work.pmid, work);
    }
  };

  // Two filter keys can't be OR-ed in one OpenAlex request, so DOIs and PMIDs
  // are separate calls — at most two per batch, not one per paper.
  const requests: Promise<void>[] = [];
  for (const [key, values] of [
    ["doi", dedupe(dois)],
    ["pmid", dedupe(pmids)],
  ] as const) {
    for (let i = 0; i < values.length; i += BATCH) {
      const slice = values.slice(i, i + BATCH);
      requests.push(
        fetchFiltered(`${key}:${slice.join("|")}`)
          .then(collect)
          .catch((err) => {
            console.warn(`[openalex] ${key} lookup failed: ${errMessage(err)}`);
          })
      );
    }
  }
  await Promise.all(requests);
  return { byDoi, byPmid };
}

// OpenAlex ORs filter values with `|`, so a value containing one would silently
// become two filters. Nothing that reaches here can (DOIs and PMIDs are matched
// by regex upstream), but dropping them keeps that true if a caller changes.
function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v && !v.includes("|")))];
}
