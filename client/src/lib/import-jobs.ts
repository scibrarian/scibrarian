import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
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
  // How many times a scan over this collection has been seen to end, for
  // useFollowedJob, which reacts to each.
  endings: (collectionId: number) => number;
  subscribe: (onChange: () => void) => () => void;
  // Ask whether a scan is running over this collection, and follow it if one
  // is. Resolves once the server has answered or failed to, and at once for a
  // scan already being followed. A scan it finds already over is not an end
  // seen here: it ended before anyone was looking, and what it changed was
  // refreshed when it did, so arriving at its collection is no reason to again.
  check: (collectionId: number) => Promise<void>;
  // Take the job a start answered with, and follow it while it runs. One that
  // is over already — a scan with nothing to do, or one that finished before
  // its answer was read — ended here and now: onSettled is told, and so is the
  // view, as when the poll sees one end.
  start: (collectionId: number, status: ImportStatus) => void;
  // Stop every poll.
  stop: () => void;
};

export function createImportJobs(
  getStatus: (collectionId: number) => Promise<ImportStatus>,
  onSettled: (collectionId: number) => void,
  // A running job matched more than it had at the last answer. For a folder's
  // lookup, which saves each round's papers as it goes and can run for most of
  // an hour; a collection's scan is refreshed when it ends, and passes none.
  onMatched?: (collectionId: number) => void
): ImportJobs {
  const known = new Map<number, ImportWatch>();
  const ended = new Map<number, number>();
  const polls = new Map<number, ReturnType<typeof setInterval>>();
  // A check already on its way, so a second one waits on it rather than asking
  // again — StrictMode mounts the view twice.
  const checks = new Map<number, Promise<void>>();
  const listeners = new Set<() => void>();

  function record(id: number, watch: ImportWatch) {
    known.set(id, watch);
    for (const listener of listeners) listener();
  }

  // Counted before the answer is recorded, so the view the record re-renders
  // reads both together.
  function end(id: number, watch: ImportWatch, settled: boolean) {
    ended.set(id, (ended.get(id) ?? 0) + 1);
    record(id, watch);
    if (settled) onSettled(id);
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
        const before = known.get(id);
        // Idle as well as done or failed: a job the server has dropped — it
        // restarted, or the collection was deleted — is over too.
        if (s.state !== "running") {
          stopPolling(id);
          end(id, s, true);
        } else {
          record(id, s);
          const grew = before && "matched" in before && s.matched > before.matched;
          if (onMatched && grew) onMatched(id);
        }
      } catch {
        // A transient failure must not freeze the progress bar: keep polling
        // and retry next tick. Only give up after several failures in a row,
        // so the "running" UI doesn't hang forever.
        // An end to the view, which says so, but not one to settle: nothing is
        // known of what the scan did.
        if (++failures >= MAX_POLL_FAILURES) {
          stopPolling(id);
          end(id, { state: "lost" }, false);
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

  function start(id: number, s: ImportStatus) {
    if (s.state === "running") follow(id, s);
    else end(id, s, true);
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
    endings: (id) => ended.get(id) ?? 0,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    check,
    start,
    stop() {
      for (const id of [...polls.keys()]) stopPolling(id);
    },
  };
}

// One collection's scan, or one folder's lookup, as the view showing it needs
// it.
//
// `watched` is the job, kept current as the poll moves it on: undefined when
// there is no id, or nothing has asked about this one yet. `checked` is whether
// the probe made on every arrival has answered — asked each time rather than
// taken from what App last heard, which may predate a job started since — for
// until it has, a pending row may be one a job is working on right now.
//
// `onEnded` is called once for each end of a job this view could see: one the
// poll found over, or lost contact with, and one a start answered with that was
// over already. Two things can be first to see a job end, and both come here,
// so a view has one place to report it. Before paint, from a layout effect: the
// render that first sees the job over still has its pre-job rows, every one
// pending, and with nothing running any more a passive effect would paint them
// for a frame as rows nothing ever looked at.
export function useFollowedJob(
  jobs: ImportJobs,
  id: number | null,
  onEnded: (watch: ImportWatch) => void
): { watched: ImportWatch | undefined; checked: boolean } {
  const watched = useSyncExternalStore(jobs.subscribe, () => (id == null ? undefined : jobs.get(id)));
  const endings = useSyncExternalStore(jobs.subscribe, () => (id == null ? 0 : jobs.endings(id)));

  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (id == null) return;
    void jobs.check(id).then(() => setChecked(true));
  }, [id, jobs]);

  const react = useRef(onEnded);
  useLayoutEffect(() => {
    react.current = onEnded;
  });
  // What was last seen, so an id changing under the view is not taken for an
  // end of the job it changed to.
  const seen = useRef({ id, endings });
  useLayoutEffect(() => {
    const was = seen.current;
    seen.current = { id, endings };
    if (was.id !== id || was.endings === endings || !watched) return;
    react.current(watched);
  }, [id, endings, watched]);

  return { watched, checked };
}
