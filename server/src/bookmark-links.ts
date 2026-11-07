import { parseRef, type ParsedRef } from "./citation-ref.js";
import {
  addBookmarks,
  existingPmids,
  getBookmarkFolder,
  linkedPapersByPmids,
  missingOrStaleCitations,
  safeParseAuthors,
  upsertArticles,
  type LinkedPaperRow,
} from "./db.js";
import { lookUpPapers, type RefIds } from "./paper-lookup.js";
import { warmCitations } from "./poller.js";
import { errMessage, httpError } from "./util.js";
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
  // A line is a PubMed link or a DOI, never both: parseRef takes the link.
  const ids = refs.map(idsOf);
  const { pmidOf, named, fetched, ambiguous } = await lookUpPapers(ids, fromPubmed);

  // --- writes: nothing is awaited from here on ---
  if (!getBookmarkFolder(folderId)) return null;
  upsertArticles(fetched);
  // Re-read rather than taken from the two sets above: a paper stored before
  // the lookups could have been deleted during them (its journal removed in
  // Settings, say), and saving it now would fail the bookmark's foreign key.
  const present = [...existingPmids(named)];
  const added = new Set(addBookmarks(folderId, present));

  // Citation counts for the papers just saved, as a poll and an import fetch
  // them for the papers they store. Left to the folder's next load, they were
  // fetched there, with the folder waiting on iCite before it could show. Not
  // awaited: no answer depends on them, and a slow or failing iCite mustn't
  // hold up a save that has already happened.
  const uncited = missingOrStaleCitations([...added]);
  if (uncited.length > 0) void warmCitations(uncited, "links");

  const papers = new Map(linkedPapersByPmids(present).map((row) => [row.pmid, toPaper(row)]));
  // A paper named twice in one paste is added by its first line; the second
  // finds it already saved, which by then it is.
  const seen = new Set<string>();
  return refs.map((parsed, i): LinkAnswer => {
    if (parsed.kind === "unknown") return { parsed, outcome: "unreadable", paper: null };
    const pmid = pmidOf(ids[i]);
    const paper = pmid ? papers.get(pmid) : undefined;
    if (!pmid || !paper) {
      const several = parsed.kind === "doi" && !!parsed.doi && ambiguous.has(parsed.doi);
      return { parsed, outcome: several ? "ambiguous-doi" : "not-in-pubmed", paper: null };
    }
    const outcome = added.has(pmid) && !seen.has(pmid) ? "added" : "already-saved";
    seen.add(pmid);
    return { parsed, outcome, paper };
  });
}

// Await one PubMed request, and report its failure as PubMed's. Only the
// requests go through here: a local read between them failing is a database
// fault, and "couldn't reach PubMed, try again in a minute" would send the
// reader to retry what retrying won't fix.
async function fromPubmed<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    console.warn(`[links] PubMed lookup failed: ${errMessage(err)}`);
    throw httpError(
      503,
      "Couldn’t reach PubMed to look these links up, so none of them were added. Try again in a minute."
    );
  }
}

function idsOf(r: ParsedRef): RefIds {
  return {
    pmid: r.kind === "pmid" ? (r.pmid ?? null) : null,
    doi: r.kind === "doi" ? (r.doi ?? null) : null,
  };
}

/** A stored paper as a folder's dialogs show it. */
export function toPaper(row: LinkedPaperRow): LinkedPaper {
  return {
    pmid: row.pmid,
    title: row.title,
    authors: safeParseAuthors(row.authors),
    journal_name: row.journal_name ?? "",
    pub_date_display: row.pub_date_display,
    url: row.url,
  };
}
