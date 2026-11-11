import { randomUUID } from "node:crypto";
import type { ImportJob } from "./types.js";
import { errMessage, safeMessage } from "./util.js";

// The background jobs this process runs on a timer of its own making, long after
// the request that started them answered: a collection's scan of its PDFs
// (importer.ts) and a bookmark folder's lookup of its imported entries
// (folder-import.ts). Each kind keeps its run here and only its run; the
// bookkeeping around it — one job per collection or folder, how one is stopped,
// what a reset forgets — is the same for both, and lives here once.
//
// In memory, one job per id. Single-user app: a server restart part way through
// leaves the rest of the rows pending, and the next run picks them up, since a
// run always drives off its pending rows. Finished jobs stay in the map, until
// the next run over the same id replaces them, so the client can read the final
// tallies. The ImportJob shape lives in shared/types.ts; both kinds report in it.

export type JobKind = "scan" | "lookup";

const jobs: Record<JobKind, Map<number, ImportJob>> = { scan: new Map(), lookup: new Map() };

// Each job's run, so cancelJob can wait for one to stop.
const runs = new WeakMap<ImportJob, Promise<void>>();

// Jobs whose collection or folder is being deleted under them. See cancelJob.
const cancelled = new WeakSet<ImportJob>();

class JobStopped extends Error {}

// What a run is handed besides its job.
export interface JobRun {
  // Called after every await on something outside this process — a PDF read, a
  // PubMed or iCite request. Those are the only points at which a delete can
  // have landed since the run last looked, so stopping at one keeps a cancelled
  // run from reading on, asking PubMed on and writing for rows that are gone.
  check(): void;
  // Stop as a cancelled run stops, for a run that finds what it works for gone
  // without having been cancelled: a reset, say, which can't see a run that
  // starts after it.
  stop(): never;
  readonly cancelled: boolean;
}

// Start a run over `total` pending rows, and answer with its job.
//
// With nothing pending the job is over before this returns, as it always was,
// so the reply that starts one can already say so.
export function startJob(
  kind: JobKind,
  id: number,
  total: number,
  label: string,
  run: (job: ImportJob, control: JobRun) => Promise<void>
): ImportJob {
  const startedAt = new Date().toISOString();
  const job: ImportJob = {
    jobId: randomUUID(),
    state: total === 0 ? "done" : "running",
    total,
    processed: 0,
    matched: 0,
    unmatched: 0,
    errors: 0,
    currentFile: null,
    startedAt,
    finishedAt: total === 0 ? startedAt : null,
  };
  jobs[kind].set(id, job);
  if (total > 0) runs.set(job, drive(job, label, run));
  return job;
}

async function drive(
  job: ImportJob,
  label: string,
  run: (job: ImportJob, control: JobRun) => Promise<void>
): Promise<void> {
  const control: JobRun = {
    check() {
      if (cancelled.has(job)) throw new JobStopped();
    },
    stop() {
      throw new JobStopped();
    },
    get cancelled() {
      return cancelled.has(job);
    },
  };
  try {
    await run(job, control);
    job.state = "done";
  } catch (err) {
    job.state = "error";
    // Nothing reads a cancelled job, which cancelJob drops the moment the run
    // settles, and nothing went wrong that the log would want.
    if (err instanceof JobStopped) return;
    // Served by the status routes, so scrubbed like any other client-facing
    // body; the log keeps the real cause.
    console.warn(`${label}: failed: ${errMessage(err)}`);
    job.error = safeMessage(err);
  } finally {
    job.currentFile = null;
    job.finishedAt = new Date().toISOString();
  }
}

export function jobStatus(kind: JobKind, id: number): ImportJob | null {
  return jobs[kind].get(id) ?? null;
}

export function isJobRunning(kind: JobKind, id: number): boolean {
  return jobs[kind].get(id)?.state === "running";
}

// The same question asked of every collection or folder at once, for the
// callers that can't name one: a whole-library reset, and the sweep of papers
// nothing holds (sweepUnheld in holding.ts), which a run's stored and not yet
// matched or bookmarked papers would otherwise be among. Of one kind, or of
// both when none is named.
//
// A scan run across a wipe lands each of its writes against something that no
// longer exists: matches on file ids that are gone, and pdf_text rows (indexed,
// and therefore searchable) keyed by the hash of a blob the reset just
// unlinked. Nothing later cleans those up, because the collection they belonged
// to is not there to be deleted again. Which is why reset refuses to start
// while a scan runs.
export function anyJobRunning(kind?: JobKind): boolean {
  for (const k of kind ? [kind] : (Object.keys(jobs) as JobKind[])) {
    for (const job of jobs[k].values()) {
      if (job.state === "running") return true;
    }
  }
  return false;
}

// Stop the run over a collection or folder that is being deleted, resolving
// once it has stopped. The flag is set before this first awaits, so a caller
// that deletes in the same tick has the run stop at the next check it reaches:
// a run only resumes from an await, and the delete has finished by then.
//
// Left running, a scan went on over rows that were gone. Most of its writes
// were updates that matched nothing, but the PDF it was reading at the time had
// its text stored again after the delete had cleared it, with nothing left that
// would ever remove it, and the papers it went on matching were stored for
// nothing to hold. A lookup left running would go on storing papers for
// bookmarks that can no longer be made.
export async function cancelJob(kind: JobKind, id: number): Promise<void> {
  const job = jobs[kind].get(id);
  if (!job) return;
  cancelled.add(job);
  await runs.get(job);
  // Its tallies are for a collection or folder that no longer exists.
  if (jobs[kind].get(id) === job) jobs[kind].delete(id);
}

// Stop every run of a kind, for a library reset, which calls this in the tick
// it deletes everything: a lookup's folder goes with the rest, and it has
// nothing left to finish. Each stops at the next check it reaches, as one does
// for a deleted folder, and what it works for being gone would stop its writes
// in any case.
export function cancelJobs(kind: JobKind): void {
  for (const job of jobs[kind].values()) cancelled.add(job);
}

// Forget every finished job. Called after a reset, which is the only thing that
// invalidates the whole map at once: entries are keyed by collection or folder
// id and deliberately outlive their run so the client can read the final
// tallies, and after a wipe those tallies describe things that no longer exist.
export function clearJobs(): void {
  for (const map of Object.values(jobs)) map.clear();
}
