import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { CacheStats, ClearedCache } from "../types";

// How much the viewer cache may hold before the header says so (see CacheChip).
// In the 1024s formatBytes counts in, so the warning starts where the size it
// prints passes "100 MB" rather than a few megabytes short of it.
export const CACHE_WARN_BYTES = 100 * 1024 * 1024;

// The desktop build's viewer cache, as the client holds it: one reading, one
// way to clear it, and the confirmation every clear goes through.
//
// One owner because two places draw from it — the header's warning and the
// Settings panel — and both can clear. Each holding its own reading meant a
// clear from one left the other still quoting the size it had just removed.
export interface ViewerCache {
  // The last reading. Three states rather than two: null while the first fetch
  // is in flight (or the build has no cache to read), "unreadable" when it
  // failed, and the stats when it worked.
  //
  // The middle one used to be spelled the same as the first. A failed read then
  // left Settings showing no size beside a button greyed out for good — a
  // control the reader could neither press nor account for.
  cache: CacheStats | "unreadable" | null;
  // A clear is running.
  clearing: boolean;
  // The confirmation is up, and nothing has been deleted yet.
  confirming: boolean;
  // Read the size again.
  reload: () => void;
  // Ask to clear. Opens the confirmation and settles when the reader answers
  // it: with what the clear did, with null if they backed out, or by rejecting
  // if the request failed. The caller reports the outcome, since where it
  // belongs depends on which button was pressed.
  requestClear: () => Promise<ClearedCache | null>;
  // The confirmation's two answers.
  proceed: () => void;
  cancel: () => void;
}

/**
 * `enabled` is whether there is a cache to ask about: the desktop build, and an
 * admin. The routes 404 everywhere else and are owner-only where they exist,
 * and asking anyway would put a failed request in the console of every server
 * deployment on every load.
 */
export function useViewerCache(enabled: boolean): ViewerCache {
  const [cache, setCache] = useState<CacheStats | "unreadable" | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Whoever is waiting on the confirmation. A ref, not state: nothing draws
  // from it, and the dialog's two buttons have to reach the same promise the
  // click that opened it is awaiting.
  const asked = useRef<{
    resolve: (cleared: ClearedCache | null) => void;
    reject: (err: unknown) => void;
  } | null>(null);
  // Which reading is the newest one asked for. Two can be out at once — coming
  // back to the window while a clear's re-read is still in flight — and the
  // older answering last would put back the size that was just cleared.
  const latest = useRef(0);

  const reload = useCallback(() => {
    const mine = ++latest.current;
    api
      .cacheStats()
      .then((stats) => {
        if (mine === latest.current) setCache(stats);
      })
      .catch(() => {
        if (mine === latest.current) setCache("unreadable");
      });
  }, []);

  // Read at the start, and again whenever the window comes back to the front.
  //
  // The second is how growth is noticed at all. A copy is made by the Electron
  // main process when a paper is opened, not by any request this page sends, so
  // nothing here is told when the cache gets bigger. What does happen is that
  // the viewer takes the focus — and returning from it is the first moment a
  // new size could matter to anyone looking at this window.
  useEffect(() => {
    if (!enabled) return;
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [enabled, reload]);

  const requestClear = useCallback(() => {
    return new Promise<ClearedCache | null>((resolve, reject) => {
      // The dialog is modal, so a second request while one is up should not be
      // reachable. If it ever is, the first is told it was not answered rather
      // than left waiting on a promise nothing will settle.
      asked.current?.resolve(null);
      asked.current = { resolve, reject };
      setConfirming(true);
    });
  }, []);

  const cancel = useCallback(() => {
    setConfirming(false);
    asked.current?.resolve(null);
    asked.current = null;
  }, []);

  const proceed = useCallback(() => {
    const waiting = asked.current;
    asked.current = null;
    setConfirming(false);
    if (!waiting) return;
    setClearing(true);
    api
      .clearCache()
      .then((cleared) => {
        // Re-read rather than assuming empty. A copy whose changes the library
        // could not take is still there, and so are its bytes — writing zeroes
        // in here would tell the reader the cache is empty while the message
        // reporting the clear says it is not.
        reload();
        waiting.resolve(cleared);
      }, waiting.reject)
      .finally(() => setClearing(false));
  }, [reload]);

  return { cache, clearing, confirming, reload, requestClear, proceed, cancel };
}
