import { randomUUID } from "node:crypto";
import {
  existingPmids,
  getBookmarkFolder,
  missingOrStaleCitations,
  pendingBookmarkImports,
  settleBookmarkImports,
  upsertArticles,
} from "./db.js";
import { lookUpPapers } from "./paper-lookup.js";
import { warmCitations } from "./poller.js";
import type { BookmarkImport, ImportJob } from "./types.js";
import { chunk, errMessage, httpError, safeMessage } from "./util.js";

// Looking up the entries a reference file brought into a bookmark folder, and
// saving the ones PubMed knows as bookmarks.
//
// The shape of the PDF scan in importer.ts, for its reasons. A file can hold
// thousands of entries and each DOI is its own throttled esearch, so this is a
// background job measured in minutes, not a request: one per folder, in
// memory, driven off the folder's pending rows. A restart part way through
// leaves the rest pending, and the next run picks them up. Finished jobs stay
// in the map so the client can read the final tallies.
//
// An entry becomes a paper only through PubMed, as a pasted link does in Add
// links: a DOI is resolved to its PMID, and the PMID's record is fetched and
// stored if the library doesn't have it yet. One PubMed has no single record
// for stays listed, unmatched, for the reader to give a PMID or remove.

const jobs = new Map<number, ImportJob>();

// Each job's run, so cancelFolderImport can wait for one to stop.
const runs = new WeakMap<ImportJob, Promise<void>>();

// Jobs whose folder is being deleted under them. See cancelFolderImport.
const cancelled = new WeakSet<ImportJob>();

class LookupCancelled extends Error {}

// Called after every await on PubMed or iCite, the only points at which a
// delete can have landed since the run last looked.
function stopIfCancelled(job: ImportJob): void {
  if (cancelled.has(job)) throw new LookupCancelled();
}

export function getFolderImportStatus(folderId: number): ImportJob | null {
  return jobs.get(folderId) ?? null;
}

export function isFolderImportRunning(folderId: number): boolean {
  return jobs.get(folderId)?.state === "running";
}

// For the callers that can't name a folder: a whole-library reset, and the
// sweep of papers nothing holds, which a round's stored and not yet bookmarked
// papers would otherwise be among. See anyImportRunning, its twin.
export function anyFolderImportRunning(): boolean {
  for (const job of jobs.values()) {
    if (job.state === "running") return true;
  }
  return false;
}

// Forget every finished job, after a reset. See clearImportJobs.
export function clearFolderImportJobs(): void {
  jobs.clear();
}

// Entries per round. A round ends in one write, so this is also how often the
// folder fills in while a long import runs.
const LOOKUP_BATCH = 50;

export function startFolderImport(folderId: number): ImportJob {
  const pending = pendingBookmarkImports(folderId);
  const job: ImportJob = {
    jobId: randomUUID(),
    state: "running",
    total: pending.length,
    processed: 0,
    matched: 0,
    unmatched: 0,
    errors: 0,
    currentFile: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(folderId, job);
  runs.set(job, runLookup(job, folderId, pending));
  return job;
}

// Stop the lookup over a folder that is being deleted, resolving once it has.
// The flag is set before this first awaits, so a delete in the same tick has
// the run stop at the next check it reaches. Left running, it would go on
// storing papers for bookmarks that can no longer be made.
export async function cancelFolderImport(folderId: number): Promise<void> {
  const job = jobs.get(folderId);
  if (!job) return;
  cancelled.add(job);
  await runs.get(job);
  if (jobs.get(folderId) === job) jobs.delete(folderId);
}

async function runLookup(job: ImportJob, folderId: number, rows: BookmarkImport[]): Promise<void> {
  try {
    for (const batch of chunk(rows, LOOKUP_BATCH)) await lookUp(job, folderId, batch);
    job.state = "done";
  } catch (err) {
    job.state = "error";
    if (err instanceof LookupCancelled) return;
    console.warn(`[folder-import] folder ${folderId}: failed: ${errMessage(err)}`);
    job.error = safeMessage(err);
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

// One round: resolve, fetch, then write. Every write happens after the last
// await, for the reason addLinksToFolder gives — a round that fails part way
// leaves its rows pending and stores nothing for them, and the papers it found
// are stored and bookmarked in the same tick, so the sweep of papers nothing
// holds has no gap to take one in.
async function lookUp(job: ImportJob, folderId: number, rows: BookmarkImport[]): Promise<void> {
  // --- network: DOIs to PMIDs, then the records the library doesn't hold ---
  // A PMID from the file is taken as it is, and its DOI looked up when there
  // isn't one or PubMed has no record of it. See lookUpPapers.
  const { pmidOf, named, fetched, ambiguous } = await lookUpPapers(rows, async (request) => {
    const answer = await fromPubmed(request);
    stopIfCancelled(job);
    return answer;
  });

  // --- writes: nothing is awaited from here on ---
  // Gone without being cancelled — the whole library reset, say, which refuses
  // to start while this runs but can't see one that starts after it.
  if (!getBookmarkFolder(folderId)) throw new LookupCancelled();
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
  stopIfCancelled(job);
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
