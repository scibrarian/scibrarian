import {
  existingPmids,
  getBookmarkFolder,
  missingOrStaleCitations,
  pendingBookmarkImports,
  settleBookmarkImports,
  upsertArticles,
} from "./db.js";
import { startJob, type JobRun } from "./jobs.js";
import { lookUpPapers } from "./paper-lookup.js";
import { warmCitations } from "./poller.js";
import type { BookmarkImport, ImportJob } from "./types.js";
import { chunk, errMessage, httpError } from "./util.js";

// Looking up the entries a reference file brought into a bookmark folder, and
// saving the ones PubMed knows as bookmarks.
//
// A background job, as the PDF scan in importer.ts is, and for its reasons. A
// file can hold thousands of entries and each DOI is its own throttled esearch,
// so this is a job measured in minutes, not a request: one per folder (see
// jobs.ts), driven off the folder's pending rows.
//
// An entry becomes a paper only through PubMed, as a pasted link does in Add
// links: a DOI is resolved to its PMID, and the PMID's record is fetched and
// stored if the library doesn't have it yet. One PubMed has no single record
// for stays listed, unmatched, for the reader to give a PMID or remove.

// Entries per round. A round ends in one write, so this is also how often the
// folder fills in while a long import runs.
const LOOKUP_BATCH = 50;

export function startFolderImport(folderId: number): ImportJob {
  const pending = pendingBookmarkImports(folderId);
  const logLabel = `[folder-import] folder ${folderId}`;
  return startJob("lookup", folderId, pending.length, logLabel, async (job, control) => {
    for (const batch of chunk(pending, LOOKUP_BATCH)) await lookUp(job, folderId, batch, control);
  });
}

// One round: resolve, fetch, then write. Every write happens after the last
// await, for the reason addLinksToFolder gives — a round that fails part way
// leaves its rows pending and stores nothing for them, and the papers it found
// are stored and bookmarked in the same tick, so the sweep of papers nothing
// holds has no gap to take one in.
async function lookUp(
  job: ImportJob,
  folderId: number,
  rows: BookmarkImport[],
  control: JobRun
): Promise<void> {
  // --- network: DOIs to PMIDs, then the records the library doesn't hold ---
  // A PMID from the file is taken as it is, and its DOI looked up when there
  // isn't one or PubMed has no record of it. See lookUpPapers.
  const { pmidOf, named, fetched, ambiguous } = await lookUpPapers(rows, async (request) => {
    const answer = await fromPubmed(request);
    control.check();
    return answer;
  });

  // --- writes: nothing is awaited from here on ---
  // Gone without being cancelled — the whole library reset, say, which refuses
  // to start while this runs but can't see one that starts after it.
  if (!getBookmarkFolder(folderId)) control.stop();
  upsertArticles(fetched);
  // Re-read rather than taken from `stored`: a paper stored before the lookups
  // may have been deleted during them, and bookmarking it would fail the
  // bookmark's foreign key.
  const present = existingPmids(named);
  const found: { id: number; pmid: string }[] = [];
  const missed: { id: number; reason: string }[] = [];
  for (const r of rows) {
    const pmid = pmidOf(r);
    if (pmid && present.has(pmid)) found.push({ id: r.id, pmid });
    else {
      const several = r.doi != null && ambiguous.has(r.doi);
      missed.push({ id: r.id, reason: several ? "ambiguous-doi" : "not-in-pubmed" });
    }
  }
  const added = settleBookmarkImports(folderId, found, missed);
  job.matched += found.length;
  job.unmatched += missed.length;
  job.processed += rows.length;

  // Citation counts for the papers just saved, as Add links and the PDF scan
  // fetch them for theirs. Awaited, as the scan does, so a long import makes one
  // iCite request a round rather than piling them up.
  const uncited = missingOrStaleCitations(added);
  if (uncited.length > 0) await warmCitations(uncited, "folder import");
  control.check();
}

// Await one PubMed request, and report its failure as PubMed's, in words the
// reader can act on. What the run hadn't reached stays pending, and is listed
// as not looked up.
async function fromPubmed<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    console.warn(`[folder-import] PubMed lookup failed: ${errMessage(err)}`);
    throw httpError(
      503,
      "Couldn’t reach PubMed, so the lookup stopped part way. The entries it didn’t reach are " +
        "listed as not looked up; try them again in a minute."
    );
  }
}
