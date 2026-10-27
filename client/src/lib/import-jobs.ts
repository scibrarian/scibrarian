import { useSyncExternalStore } from "react";
import type { ImportStatus } from "../types";

// The scans running over collections, followed for as long as the app is open
// rather than for as long as a collection is on screen.
//
// The poll used to belong to CollectionView, and went when it did. A scan that
// finished after the reader had moved on — to Interests, to another collection —
// then had nothing to refresh what it changed, and the collection came back
// painting its pre-scan file list from cache: every row still 'pending', with
// nothing scanning them. App makes one of these and is told, through
// onSettled, when any scan ends, whether or not its collection is on screen.
//
// A store rather than state in App, so a tick re-renders the view that draws
// the progress bar and not the whole app under it.

// Consecutive failed status polls before we give up on a running import. A
// single blip must not freeze the progress UI, but a truly-dead server
// shouldn't be polled forever either. At the 1s tick this is ~5s of retries.
const MAX_POLL_FAILURES = 5;

// What is known of one collection's scan: the server's last answer, or "lost"
// once MAX_POLL_FAILURES polls in a row have failed and it is no longer asked.
export type ImportWatch = ImportStatus | { state: "lost" };

export type ImportJobs = {
  // Undefined for a collection nothing has asked about yet.
  get: (collectionId: number) => ImportWatch | undefined;
  subscribe: (onChange: () => void) => () => void;
  // Ask whether a scan is running over this collection, and follow it if one
  // is. Resolves once the server has answered or failed to, and at once for a
  // scan already being followed.
  check: (collectionId: number) => Promise<void>;
  // Take a status already read — the one asked for right after starting a
  // scan — and follow the scan if it is still running.
  follow: (collectionId: number, status: ImportStatus) => void;
  // Stop every poll.
  stop: () => void;
};

export function createImportJobs(
  getStatus: (collectionId: number) => Promise<ImportStatus>,
  onSettled: (collectionId: number) => void
): ImportJobs {
  const known = new Map<number, ImportWatch>();
  const polls = new Map<number, ReturnType<typeof setInterval>>();
  // A check already on its way, so a second one waits on it rather than asking
  // again — StrictMode mounts the view twice.
  const checks = new Map<number, Promise<void>>();
  const listeners = new Set<() => void>();

  function record(id: number, watch: ImportWatch) {
    known.set(id, watch);
    for (const listener of listeners) listener();
  }

  function stopPolling(id: number) {
    clearInterval(polls.get(id));
    polls.delete(id);
  }

  function poll(id: number) {
    if (polls.has(id)) return;
    // Scoped to this poll. inFlight stops slow responses from stacking
    // requests — without it, several polls can be outstanding at once and each
    // reports the scan ending.
    let inFlight = false;
    let failures = 0;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const s = await getStatus(id);
        failures = 0;
        record(id, s);
        // Idle as well as done or failed: a job the server has dropped — it
        // restarted, or the collection was deleted — is over too.
        if (s.state !== "running") {
          stopPolling(id);
          onSettled(id);
        }
      } catch {
        // A transient failure must not freeze the progress bar: keep polling
        // and retry next tick. Only give up after several failures in a row,
        // so the "running" UI doesn't hang forever.
        if (++failures >= MAX_POLL_FAILURES) {
          stopPolling(id);
          record(id, { state: "lost" });
        }
      } finally {
        inFlight = false;
      }
    }, 1000);
    polls.set(id, timer);
  }

  function follow(id: number, s: ImportStatus) {
    record(id, s);
    if (s.state === "running") poll(id);
  }

  function check(id: number): Promise<void> {
    if (polls.has(id)) return Promise.resolve();
    let asked = checks.get(id);
    if (!asked) {
      // A failed check is no answer, and nothing is recorded for it: the view
      // treats it as no scan, rather than leave its rows waiting on one.
      asked = getStatus(id)
        .then(
          (s) => follow(id, s),
          () => {}
        )
        .finally(() => checks.delete(id));
      checks.set(id, asked);
    }
    return asked;
  }

  return {
    get: (id) => known.get(id),
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    check,
    follow,
    stop() {
      for (const id of [...polls.keys()]) stopPolling(id);
    },
  };
}

// One collection's scan, kept current as the poll moves it on. Undefined when
// there is no collection, or nothing has asked about this one yet.
export function useImportJob(jobs: ImportJobs, collectionId: number | null): ImportWatch | undefined {
  return useSyncExternalStore(jobs.subscribe, () =>
    collectionId == null ? undefined : jobs.get(collectionId)
  );
}
