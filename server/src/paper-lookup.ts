import { existingPmids, pmidsByDois, type ArticleInsert } from "./db.js";
import { EUTILS_BATCH, fetchArticles, pmidsForDoi } from "./pubmed.js";
import { chunk } from "./util.js";

// The one way a reference becomes a paper, shared by Add links and a bookmark
// folder's reference-file import: a DOI is resolved to its PMID, asked of the
// library first and then of PubMed, and the record of every PMID the library
// doesn't hold is fetched.
//
// Nothing is written here. Both callers write after their last await, for the
// reasons addLinksToFolder gives, so they store `fetched` themselves once this
// returns.

/** What a reference names its paper by. */
export interface RefIds {
  pmid: string | null;
  /** Lowercased, as findDoi gives it. */
  doi: string | null;
}

export interface LookedUp {
  /** The PMID a reference resolved to, or null when it resolved to none. */
  pmidOf: (ref: RefIds) => string | null;
  /** Every PMID a reference resolved to, once each. */
  named: string[];
  /** Records the library didn't hold, for the caller to store. */
  fetched: ArticleInsert[];
  /**
   * DOIs PubMed files under more than one record. Unresolved like a DOI it has
   * never heard of, but told apart from one: the paper is in PubMed, and its
   * PMID would save it.
   */
  ambiguous: Set<string>;
}

/** Each PubMed request is awaited through the caller's `ask`, so the caller
 * reports a failure in its own words and can stop between requests. Local
 * reads are not: a database fault is not PubMed being unreachable. */
export type Ask = <T>(request: Promise<T>) => Promise<T>;

/**
 * Resolve references to the PMIDs of papers PubMed has a record of.
 *
 * A PMID is taken as given, and a DOI is looked up when there is no PMID — or
 * when PubMed has no record of the one given, so that a mistyped or stale PMID
 * beside a good DOI still finds its paper. That second round is only asked for
 * when a given PMID comes back with nothing, which is rare.
 */
export async function lookUpPapers(refs: readonly RefIds[], ask: Ask): Promise<LookedUp> {
  const byDoi = new Map<string, string>();
  const ambiguous = new Set<string>();
  const searched = new Set<string>();
  // DOIs to PMIDs. Asked locally first: a DOI the library already stores needs
  // no search.
  const resolve = async (dois: string[]) => {
    const fresh = dois.filter((d) => !searched.has(d));
    for (const doi of fresh) searched.add(doi);
    for (const [doi, pmid] of pmidsByDois(fresh)) byDoi.set(doi, pmid);
    // One at a time: each is its own esearch, and they share the eutils
    // throttle whichever order they go in.
    for (const doi of fresh) {
      if (byDoi.has(doi)) continue;
      const pmids = await ask(pmidsForDoi(doi));
      if (pmids.length === 1) byDoi.set(doi, pmids[0]);
      else if (pmids.length > 1) ambiguous.add(doi);
    }
  };

  const fetched: ArticleInsert[] = [];
  // PMIDs with a record: stored, or fetched here.
  const known = new Set<string>();
  const tried = new Set<string>();
  const find = async (pmids: string[]) => {
    const fresh = pmids.filter((p) => !tried.has(p));
    for (const pmid of fresh) tried.add(pmid);
    const stored = existingPmids(fresh);
    for (const pmid of stored) known.add(pmid);
    for (const batch of chunk(fresh.filter((p) => !stored.has(p)), EUTILS_BATCH)) {
      for (const article of await ask(fetchArticles(batch))) {
        fetched.push(article);
        known.add(article.pmid);
      }
    }
  };

  // The PMIDs given, and the DOIs of references that give none.
  await resolve(unique(refs.flatMap((r) => (r.pmid == null && r.doi ? [r.doi] : []))));
  await find(unique([...refs.flatMap((r) => r.pmid ?? []), ...byDoi.values()]));
  // Then the DOI of a reference whose PMID PubMed has no record of.
  await resolve(unique(refs.flatMap((r) => (r.pmid != null && !known.has(r.pmid) && r.doi ? [r.doi] : []))));
  await find([...byDoi.values()]);

  const pmidOf = (r: RefIds): string | null => {
    if (r.pmid != null && known.has(r.pmid)) return r.pmid;
    const pmid = r.doi ? byDoi.get(r.doi) : undefined;
    return pmid != null && known.has(pmid) ? pmid : null;
  };
  return { pmidOf, named: unique(refs.flatMap((r) => pmidOf(r) ?? [])), fetched, ambiguous };
}

const unique = (values: string[]): string[] => [...new Set(values)];
