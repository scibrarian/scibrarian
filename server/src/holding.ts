import {
  deleteBookmarkFolder,
  deleteCollection,
  deleteCollectionFile,
  dropUnheldArticles,
  removeBookmark,
  removeBookmarks,
  removeCollectionPapers,
  resetLibrary,
  setFileMatched,
  upsertArticles,
  type ArticleInsert,
} from "./db.js";
import { clearCheckouts, discardOrphanedCheckouts } from "./external-open.js";
import { anyJobRunning, cancelJob, cancelJobs, clearJobs } from "./jobs.js";
import { pollRunning, withPollLock } from "./poller.js";
import { resetProContent } from "./pro-hooks.js";
import type { CollectionFile, LibraryStats } from "./types.js";
import { errMessage } from "./util.js";

// Letting go of papers: every way a holder lets go of what it holds, and the
// sweep that deletes the papers nothing holds any longer (see GLOSSARY.md for
// what holds one).
//
// A removal is not one step, and the steps have an order. A job over what is
// going is told to stop in the same tick as the delete; the rows go; the
// checked-out copies no row names any longer go after them; the route answers;
// then, behind the reply, the job is waited for and the sweep takes its turn —
// unless something is part way through storing a paper and attaching it, in
// which case it skips. Each removal used to spell that out for itself in its
// route. Here because it needs db.ts, external-open.ts and jobs.ts at once, and
// none of them can call the others: external-open.ts is built on db.ts, so
// db.ts cannot reach the checked-out copies, and neither knows which jobs are
// writing for the rows it deletes.

// ---------- what is part way through attaching ----------

// Writes outside a job that have found a paper stored and have yet to attach it
// to what it is stored for, across an await:
//
// - "attach": pasted links, which read which of their papers the library has,
//   wait on PubMed for the rest, and bookmark them all after the wait; and a
//   PMID given to an imported entry, which does the same for one paper. Each
//   reads its folder or entry again after the wait and writes nothing if it has
//   gone, so a reset need not wait for one.
// - "transfer": a copy arriving from another library (storePulledFile in
//   pro-storage.ts), which stores the paper, then its blob, then files it. It
//   checks nothing again before its writes, so a reset refuses while one is out.
//
// A count rather than a flag: two nodes can be pushing at once, or two pastes
// running, and a flag cleared by whichever finished first would report the
// library as idle while the other was still mid-write.
export type LeaseKind = "attach" | "transfer";

const leases: Record<LeaseKind, number> = { attach: 0, transfer: 0 };

export async function whileAttaching<T>(kind: LeaseKind, work: () => Promise<T>): Promise<T> {
  leases[kind]++;
  try {
    return await work();
  } finally {
    leases[kind]--;
  }
}

// ---------- the sweep ----------

// Delete the papers nothing holds any longer, after a removal that may have let
// go of some. dropUnheldArticles says why this is not part of the removal: a
// paper is stored before what it is stored for is attached to it, and one swept
// in between leaves a file matched to a paper that isn't there.
//
// So it is skipped, not waited for, while anything is part way through that: a
// collection's scan or a folder's lookup, a poll, or one of the writes counted
// above. Nothing is lost by a skip. The sweep is of the whole library, so the
// next removal to find the server idle takes what this one left, and a start
// takes the rest.
//
// It can't fail the removal it follows: that has happened, and what a failed
// sweep leaves behind is rows nobody can see.
function sweepUnheld(): void {
  if (leases.attach > 0 || leases.transfer > 0 || anyJobRunning()) return;
  if (pollRunning()) return;
  try {
    dropUnheldArticles();
  } catch (err) {
    console.warn(`[holding] sweeping papers nothing holds failed: ${errMessage(err)}`);
  }
}

// The papers nothing holds any longer, taken at startup because then is when
// nothing is half way through storing one: before the bind, so no scan or
// manual match can be running, and before loadPro, which arms Pro's sweep and
// its pulls. See dropUnheldArticles.
//
// It can't fail the start, as it can't fail a removal: what a failed sweep
// leaves behind is rows nobody can see, and the next removal to find the server
// idle, or the next start, takes them.
export function sweepAtStartup(): void {
  try {
    const papers = dropUnheldArticles();
    if (papers > 0) {
      console.log(`[db] removed at startup — stored papers nothing held: ${papers}`);
    }
  } catch (err) {
    console.warn(`[db] sweeping papers nothing holds failed at startup: ${errMessage(err)}`);
  }
}

// ---------- letting go ----------

// What a removal answers with: what it did, for its reply, and the rest of it,
// which runs behind the reply. A route sends its reply and leaves `swept` to
// run; a test awaits it. It never rejects.
export interface Released<T = void> {
  result: T;
  swept: Promise<void>;
}

// The rest of a removal: wait for the job over what went to stop, if there was
// one, then give the sweep its turn, if the removal took anything — a removal
// that took nothing has left nothing new for a sweep of every stored paper to
// find.
//
// Behind the reply, so a PubMed request the job is part way through doesn't
// hold the delete up, and neither does the sweep reading the whole library.
// After setImmediate rather than a resolved promise: the reply is sent from the
// route's own continuation once the removal resolves, and a microtask queued
// here could run ahead of it.
function behindReply(jobStopped: Promise<void> | null, sweep: boolean): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => jobStopped ?? undefined)
    .then(() => {
      if (sweep) sweepUnheld();
    });
}

// A bookmark folder. Its bookmark rows cascade, and so do the entries an import
// left unmatched; the papers they pointed at stay, but for the ones nothing
// else holds, which the sweep takes.
//
// A lookup still running over its entries is told to stop in the same tick as
// the delete, which is what keeps it from writing after it (see cancelJob), and
// waited for before the sweep, which skips its turn while it runs.
export function letGoOfFolder(folderId: number): Released {
  const lookupStopped = cancelJob("lookup", folderId);
  deleteBookmarkFolder(folderId);
  return { result: undefined, swept: behindReply(lookupStopped, true) };
}

// Papers ticked out of a folder. Answers with how many were still in it.
export function letGoOfFolderPapers(folderId: number, pmids: string[]): Released<number> {
  const removed = removeBookmarks(folderId, pmids);
  return { result: removed, swept: behindReply(null, removed > 0) };
}

// One paper off a folder, with no sweep after it. It is the toggle in
// Interests, pressed a paper at a time, and a paper listed there is in a
// topic's feed: taking it off a folder leaves it held.
export function letGoOfFolderPaper(folderId: number, pmid: string): void {
  removeBookmark(folderId, pmid);
}

// A collection. Rows cascade and orphaned blobs are GC'd inside
// deleteCollection; the checked-out copies of those rows are the half it cannot
// reach — see discardOrphanedCheckouts, and the note on the dialog that promises
// "any stored PDF copies are deleted".
//
// A scan over the collection is told to stop in the same tick as the delete,
// which is what keeps it from writing after it (see cancelJob). Its stopping is
// waited for behind the reply, and before the sweep, which skips its turn while
// any scan is running.
export async function letGoOfCollection(collectionId: number): Promise<Released> {
  const scanStopped = cancelJob("scan", collectionId);
  deleteCollection(collectionId);
  await discardOrphanedCheckouts();
  return { result: undefined, swept: behindReply(scanStopped, true) };
}

// One file. Its blob is GC'd inside deleteCollectionFile if this was the last
// reference, and its checked-out copy is discarded here, for the same reason.
//
// The collection's scan is not stopped: it has the collection's other files
// still to read. What keeps the deleted one's text from coming back is
// savePdfText, which stores none for a blob no file names.
export async function letGoOfFile(fileId: number): Promise<Released> {
  deleteCollectionFile(fileId);
  await discardOrphanedCheckouts();
  return { result: undefined, swept: behindReply(null, true) };
}

// Papers taken out of a collection. Answers with both counts, files and papers,
// for the reasons removeCollectionPapers gives.
export async function letGoOfCollectionPapers(
  collectionId: number,
  pmids: string[]
): Promise<Released<{ removed: number; papers: number }>> {
  const removal = removeCollectionPapers(collectionId, pmids);
  await discardOrphanedCheckouts();
  return { result: removal, swept: behindReply(null, removal.removed > 0) };
}

// A file matched by hand to the paper the reader named, whose record the caller
// has just fetched. Stored and matched with nothing awaited in between, so
// there is no instant at which the paper is stored and the file doesn't hold it
// yet, for the sweep to take it in. The sweep then has a turn for the paper the
// file was matched to before, if this was a second match.
export function rematchFile(
  file: CollectionFile,
  pmid: string,
  articles: ArticleInsert[]
): Released {
  upsertArticles(articles);
  setFileMatched(file.id, pmid, "manual");
  return { result: undefined, swept: behindReply(null, !!file.pmid && file.pmid !== pmid) };
}

// ---------- letting go of everything ----------

// What deleteAllData refused to run alongside, or what it deleted.
export type ResetRefusal = "scan" | "transfer" | "refresh";
export type ResetOutcome = { refused: ResetRefusal } | { stats: LibraryStats };

// Delete the whole library — "Delete all data". Irreversible.
//
// Held against the same lock a manual refresh takes, rather than merely
// checking a flag: a poll that overlapped this would be inserting papers into
// topics as they are deleted — articles saved against a topic_id the
// transaction is removing, which the foreign key refuses, and a poller that
// then reports a failure for a topic the user meant to be gone.
//
// Scans are a separate question and answered separately, because they are not
// what the poll lock covers. They also cannot be waited for: a scan is a
// background job with no lock to take and no bound on how long it runs, so the
// honest answer is to refuse and let the owner press the button again once it
// finishes.
//
// Except a folder's lookup, which is stopped instead. It can run for most of an
// hour, and the reset is deleting everything it works on — the folder, its
// entries, their bookmarks — so there is nothing to wait for. It is stopped in
// the tick the reset runs in, under the lock, so a reset the lock refuses stops
// nothing; and each round's writes check that its folder still exists, so one
// between awaits when the reset lands writes nothing after it. The "attach"
// writes need nothing at all, for the same reason.
//
// Transfers are the third, and the one easiest to forget, because on a Pro
// instance the writer is not this instance at all. A paired node pushing up and
// a master being pulled from both land in storePulledFile, which is mounted
// outside the router, is not a job in jobs.ts, and takes no lock — so the poll
// lock says nothing about it. They write article rows and blobs across awaits,
// so without this the wipe lands between a transfer's checks and its writes,
// leaving a blob nothing references or an articles row that outlived "delete
// everything". Refused rather than waited for, like a scan: the transfer is not
// this instance's to hurry, and the window is a network round trip wide.
//
// The refusals are ordered cheapest first and both ahead of the lock, so a
// refused reset never takes one.
export async function deleteAllData(): Promise<ResetOutcome> {
  if (anyJobRunning("scan")) return { refused: "scan" };
  if (leases.transfer > 0) return { refused: "transfer" };
  const stats = await withPollLock(async () => {
    cancelJobs("lookup");
    return resetLibrary();
  });
  if (stats === null) return { refused: "refresh" };
  // After the deletion, never before it: each of these is tidying up around a
  // wipe that has already happened, and none is allowed to prevent one.
  clearJobs();
  resetProContent();
  // The checked-out copies, which are the one part of a stored PDF that
  // resetLibrary cannot reach. It deletes the blobs and the rows; a copy is
  // neither, and it is a plaintext PDF under the paper's own name sitting in
  // a directory the reader can open. Leaving those behind would make "and
  // every stored PDF" false in the sentence the button is asking about, for
  // every paper opened in a viewer — which is exactly the set someone
  // resetting a library to get rid of sensitive papers has been reading.
  //
  // Every row is gone by now, so each copy is an orphan and clearCheckouts
  // takes it — its one refusal, a save that was never finished, cannot arise
  // when there is no row left to hold the changes for.
  //
  // Allowed to fail, like the blob sweep inside resetLibrary and for the same
  // reason: the wipe has committed, nothing rolls it back, and a directory
  // that could not be removed must not be reported as a reset that did not
  // happen.
  try {
    await clearCheckouts();
  } catch (err) {
    console.warn(`[holding] clearing checked-out copies after reset failed: ${errMessage(err)}`);
  }
  // The schedule survives (poll_cron and poll_enabled are settings, not
  // contents), and with no topics left there is nothing for it to poll — but
  // it is still armed, so nothing needs rescheduling here.
  return { stats };
}
