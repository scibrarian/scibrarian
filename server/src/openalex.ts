import { getSetting } from "./db.js";
import { fetchWithTimeout } from "./http.js";
import { errMessage } from "./util.js";

// OpenAlex work lookup, for the identifiers "do I already have this?" cannot
// resolve on its own: a DOI we can't find locally may still be a paper we hold
// under its PMID, so resolving it here gives the holdings check a second,
// better-informed look — and gives the org and other-workspace passes a PMID to
// ask about where the pasted line had none.
//
// It also used to report a legal free copy, which is what open_access and
// best_oa_location were selected for. That was removed: OpenAlex's best OA
// location includes bronze — a publisher landing page with no license — so the
// link could point somewhere that was not the paper, under a confident label
// naming a repository.
//
// This is also the first use of the OpenAlex *works* API in the codebase
// (journal-catalog.ts uses /sources for journal metrics). The roadmap's
// iCite → OpenAlex move would build on this endpoint; nothing here presumes it.
const OPENALEX_WORKS = "https://api.openalex.org/works";

// Only what the check reads. Asking for the whole work record would pull
// abstracts and full authorship lists for papers nobody has decided to buy yet.
const SELECT = "ids,title,publication_year";

// OpenAlex allows up to 200 per page; 50 keeps the filter URL comfortably short
// (DOIs are long) and matches the cap journal-catalog.ts uses.
const BATCH = 50;

export interface OaWork {
  pmid: string | null;
  doi: string | null; // bare and lowercased, matching how DOIs are stored here
  title: string;
  year: number | null;
}

interface OaResult {
  ids?: { doi?: string; pmid?: string };
  title?: string | null;
  publication_year?: number | null;
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
