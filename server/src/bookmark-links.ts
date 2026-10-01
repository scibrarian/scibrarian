import { parseRef, type ParsedRef } from "./citation-ref.js";
import {
  addBookmarks,
  bookmarkedIn,
  existingPmids,
  getBookmarkFolder,
  holdingsByPmids,
  pmidsByDois,
  safeParseAuthors,
  upsertArticles,
  type ArticleInsert,
  type HoldingRow,
} from "./db.js";
import { fetchArticles, resolveDoiToPmid } from "./pubmed.js";
import { chunk, errMessage, httpError } from "./util.js";
import type { LinkAnswer, LinkedPaper } from "./types.js";

// "Add links" — saving papers into a bookmark folder from pasted DOIs and
// PubMed links, for a paper found somewhere other than Interests.
//
// The lines are read by the same parser as Check holdings (citation-ref.ts), so
// the two boxes take the same paste and refuse the same things. A line becomes
// a paper only through PubMed: a DOI is resolved to its PMID, and the PMID's
// record is fetched and stored if the library doesn't have it yet. A DOI PubMed
// has no record for can't be saved — a bookmark is a row keyed on a stored
// article's PMID, and the app holds nothing that isn't a PubMed paper.

// PMIDs per esummary/efetch call (the importer's and the poller's batch size).
const FETCH_BATCH = 100;

/**
 * Save the papers these lines name into a folder, and say what happened to
 * each line, in the order given.
 *
 * Returns null when the folder was deleted while PubMed was being asked, which
 * the route reports as a 404.
 *
 * Every write happens after the last await. The lookups take seconds, and a
 * folder deleted or a library reset in that time must not be written into:
 * checked first and written after, with nothing awaited in between, there is no
 * gap for either to land in. It also means a failed lookup leaves nothing
 * behind — no article stored for a bookmark that was never made.
 */
export async function addLinksToFolder(
  folderId: number,
  inputs: string[]
): Promise<LinkAnswer[] | null> {
  const refs = inputs.map(parseRef);

  // --- network: DOIs to PMIDs, then the records the library doesn't hold ---
  const dois = [...new Set(refs.flatMap((r) => (r.kind === "doi" && r.doi ? [r.doi] : [])))];
  // Asked locally first: a DOI the library already stores needs no search.
  const byDoi = pmidsByDois(dois);
  const pmidOf = (r: ParsedRef): string | null =>
    r.kind === "pmid" ? (r.pmid ?? null) : r.kind === "doi" && r.doi ? (byDoi.get(r.doi) ?? null) : null;

  const fetched: ArticleInsert[] = [];
  // Every PMID a line names, once DOIs have been resolved.
  let named: string[] = [];
  try {
    // One at a time: each is its own esearch, and they share the eutils
    // throttle whichever order they go in.
    for (const doi of dois) {
      if (byDoi.has(doi)) continue;
      const pmid = await resolveDoiToPmid(doi);
      if (pmid) byDoi.set(doi, pmid);
    }
    named = [...new Set(refs.flatMap((r) => pmidOf(r) ?? []))];
    const stored = existingPmids(named);
    for (const batch of chunk(named.filter((p) => !stored.has(p)), FETCH_BATCH)) {
      fetched.push(...(await fetchArticles(batch)));
    }
  } catch (err) {
    console.warn(`[links] PubMed lookup failed: ${errMessage(err)}`);
    throw httpError(
      503,
      "Couldn’t reach PubMed to look these links up, so none of them were added. Try again in a minute."
    );
  }

  // --- writes: nothing is awaited from here on ---
  if (!getBookmarkFolder(folderId)) return null;
  upsertArticles(fetched);
  // Re-read rather than taken from the two sets above: a paper stored before
  // the lookups could have been deleted during them (its journal removed in
  // Settings, say), and saving it now would fail the bookmark's foreign key.
  const present = [...existingPmids(named)];
  const before = bookmarkedIn(folderId, present);
  addBookmarks(folderId, present.filter((p) => !before.has(p)));

  const papers = new Map(holdingsByPmids(present).map((row) => [row.pmid, toPaper(row)]));
  // A paper named twice in one paste is added by its first line; the second
  // finds it already saved, which by then it is.
  const seen = new Set<string>();
  return refs.map((parsed): LinkAnswer => {
    if (parsed.kind === "unknown") return { parsed, outcome: "unreadable", paper: null };
    const pmid = pmidOf(parsed);
    const paper = pmid ? papers.get(pmid) : undefined;
    if (!pmid || !paper) return { parsed, outcome: "not-in-pubmed", paper: null };
    const outcome = before.has(pmid) || seen.has(pmid) ? "already-saved" : "added";
    seen.add(pmid);
    return { parsed, outcome, paper };
  });
}

function toPaper(row: HoldingRow): LinkedPaper {
  return {
    pmid: row.pmid,
    title: row.title,
    authors: safeParseAuthors(row.authors),
    journal_name: row.journal_name ?? "",
    pub_date_display: row.pub_date_display,
    url: row.url,
  };
}
