import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { errorMessage } from "./format";
import { commitWithFade } from "./transition";

// The given value, trailing `ms` behind its live counterpart.
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// Whether a media query matches, kept current as it changes. False, and
// inert, where there is no matchMedia (jsdom): the two callers below are a
// colour the canvas picks and a column the table drops, and a test runtime
// gets the wide, light answer for both.
//
// Asked of the browser on every render rather than kept in state. State seeded
// at mount answered for the query it was mounted with, and a caller that
// changed the query kept the old one's answer until the viewport next crossed
// the new one's breakpoint.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false
  );
}

// Tracks the system light/dark preference so canvas drawing (which isn't styled
// by CSS variables) can recolor to stay visible.
export function usePrefersDark(): boolean {
  return useMediaQuery("(prefers-color-scheme: dark)");
}

// True from a change of `key` (and from mount) until `ms` later. The bound on
// how long one answer may be held back for another — see useFacetHold.
//
// Kept with the key it is about and read against the key at render time, as
// useCachedFetch's state is. The effect restarts the clock a commit after the
// key changes, and a bare flag gave the render in between the previous key's
// answer.
export function useRecent(key: string, ms: number): boolean {
  const [state, setState] = useState({ key, recent: true });
  useEffect(() => {
    setState((s) => (s.key === key && s.recent ? s : { key, recent: true }));
    const t = setTimeout(() => setState({ key, recent: false }), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return state.key !== key || state.recent;
}

// The `ready` flag, lagging its rise by one cross-fade.
//
// A view that paints a stand-in and then its content hands the swap to this
// rather than branching on `ready` itself: the render that first sees `ready`
// still draws the stand-in, and the effect commits the swap inside a View
// Transition (see lib/transition), so the stand-in's pixels fade into the
// content's instead of cutting to them.
//
// Ready from the first render — a cached source, or papers the bootstrap
// warmed before the view mounted — paints the content at once, with no
// transition: there is no stand-in on screen to fade from. Ready falling (a
// switch to an uncached source) is answered on that same render, before the
// effect: a frame of the previous source's rows under the new source's name
// would be worse than a cut to shimmer.
//
// `key` names what is being revealed — the source, in the paper views, which
// stay mounted from one source to the next. A change of it counts as a mount:
// the new key starts at whatever `ready` is on its first render. Without it
// the lag in hand was the previous source's, and leaving a source still on its
// stand-in for one that was ready (cached, or known to be empty) drew the
// stand-in under the new source and then faded it out. Omitted where only one
// thing is ever revealed (Settings).
export function useReveal(ready: boolean, key = ""): boolean {
  const [state, setState] = useState({ key, shown: ready });
  // Another key's state is no answer for this one (see useRecent).
  const shown = state.key === key ? state.shown : ready;
  useEffect(() => {
    if (state.key === key && ready === shown) return;
    if (state.key !== key || !ready) {
      setState({ key, shown: ready });
      return;
    }
    // The transition runs this a frame on, by when the key may have moved; a
    // rise that belonged to the key just left is dropped rather than recorded.
    commitWithFade(() => setState((s) => (s.key === key ? { key, shown: true } : s)));
  }, [ready, shown, key, state.key]);
  return ready && shown;
}

// A list can hold thousands of items; render them incrementally so the first
// paint stays cheap. `shown` is the first PAGE_SIZE items, growing by a page
// whenever the sentinel (rendered by the caller near the bottom, while
// `hasMore`) scrolls into view — rootMargin preloads the next page before the
// user hits the very end. A `resetKey` change (new source, search, reload)
// snaps back to the first page.
const PAGE_SIZE = 50;

export function useIncrementalList<T>(items: T[], resetKey: string) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [resetKey]);

  const shown = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const hasMore = visibleCount < items.length;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setVisibleCount((c) => c + PAGE_SIZE);
      },
      { rootMargin: "800px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, items.length]);

  return { shown, hasMore, sentinelRef };
}

// A module-level cache for useCachedFetch: one entry per key, invalidated when
// `token` no longer matches. Callers pass the token for the source they're
// showing (see lib/reload), bumped whenever that source's data changes, e.g. by
// "Check for new papers".
export type FetchCache<T> = Map<string, { token: number; data: T }>;

// Cap each cache so a long session — every distinct search prefix mints a key —
// can't pin unbounded responses in memory. LRU: re-inserting on write/hit keeps
// the Map ordered oldest-first, so evicting from the front drops the
// least-recently-used entry. Sized to comfortably hold a session's worth of
// recent views (the point of the cache) while bounding the worst case.
const MAX_CACHE_ENTRIES = 30;

function cacheTouch<T>(cache: FetchCache<T>, key: string, value: { token: number; data: T }): void {
  cache.delete(key); // re-insert at the end so Map order tracks recency
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// The requests warmCache has out, per cache, so that a view mounting before
// one lands can wait on it rather than ask the server the same thing again.
// Beside the caches rather than inside them: a FetchCache holds answers, and
// everything that reads or seeds one treats it as a plain Map of them.
type Warming = Map<string, { token: number; request: Promise<unknown> }>;
const warming = new WeakMap<object, Warming>();

function warmRequest<T>(cache: FetchCache<T>, key: string, token: number): Promise<T> | undefined {
  const out = warming.get(cache)?.get(key);
  // Only warmCache<T> files under a FetchCache<T>, so this is a Promise<T>.
  return out && out.token === token ? (out.request as Promise<T>) : undefined;
}

// Ask for a key's data ahead of the view that will read it, and file the
// answer under the (key, token) that view's useCachedFetch looks up, so the
// view mounts onto a cache hit and paints its content on the first render.
//
// The request is on record for as long as it is out. A view that mounts before
// the answer lands — the caller stopped waiting, which is the slow case, the
// one a warm-up is for — finds it there and waits on it. Unrecorded, the view
// missed the cache and asked again, so the server did its slowest work twice;
// and the warm answer then landed in a Map nothing re-renders from, leaving the
// view on its stand-in until its own copy came back.
//
// Resolves either way, once the answer is filed or the request has failed. A
// failure leaves nothing behind, and the view then fetches as it would have.
export function warmCache<T>(
  cache: FetchCache<T>,
  key: string,
  token: number,
  fetcher: () => Promise<T>
): Promise<void> {
  const hit = cache.get(key);
  if (hit && hit.token === token) return Promise.resolve();
  let request = warmRequest(cache, key, token);
  if (!request) {
    const started = (request = fetcher());
    const out: Warming = warming.get(cache) ?? new Map();
    warming.set(cache, out);
    const filed = { token, request: started };
    out.set(key, filed);
    const settled = () => {
      // Unless a later warm-up of this key has taken the slot since.
      if (out.get(key) === filed) out.delete(key);
    };
    started.then((data) => {
      settled();
      cacheTouch(cache, key, { token, data });
    }, settled);
  }
  // Chained after the handlers above, so by the time a caller awaiting this
  // resumes the cache holds the answer and the record no longer holds the
  // request — a failed one is not there to be handed to whoever asks next.
  return request.then(
    () => {},
    () => {}
  );
}

// Fetch-with-cache for view data. `data` is null until the *current* key's
// result is available, so callers never see another key's data.
//
// Everything the caller sees is derived at render time from the cache and
// keyed state — not from state an effect updates one tick later. Deriving
// fixes two flashes: switching sources used to render one frame with the old
// `loading=false` and no data (an empty-state blink before the skeleton), and
// returning to a cached source rendered one null frame before the cached data
// appeared. A reload (same key, bumped token) still reports loading while the
// previous data stays visible, exactly as before.
export function useCachedFetch<T>(
  cache: FetchCache<T>,
  key: string,
  token: number,
  fetcher: () => Promise<T>
): { data: T | null; loading: boolean; error: string | null } {
  const lookup = () => {
    const hit = cache.get(key);
    return hit && hit.token === token ? hit.data : undefined;
  };
  // Fetch results land in `entry` (a bare cache.set wouldn't re-render); it
  // also keeps the current key's data alive if the LRU evicts it mid-view. The
  // token rides along for `loading` below rather than for `data`: a bumped
  // token deliberately keeps the previous answer on screen, so `data` still
  // matches on the key alone.
  const [entry, setEntry] = useState<{ key: string; token: number; data: T } | null>(null);
  // Errors are keyed by (key, token) so a stale one can't leak across a
  // source switch, and bumping the token to retry clears it implicitly.
  const [err, setErr] = useState<{ id: string; message: string } | null>(null);

  const hit = lookup();
  const data = entry && entry.key === key ? entry.data : hit !== undefined ? hit : null;
  const error = err && err.id === `${key}:${token}` ? err.message : null;
  // Which token produced what is on screen — not the same question as whether
  // the cache holds anything for this one. cacheTouch writes to a plain Map
  // synchronously and setEntry only commits a render later, so in between `hit`
  // is already the new answer while `data` is still the old one. Reading
  // `loading` off `hit` alone reported "landed" over the previous token's
  // contents, and a caller that decides something once on that edge decided it
  // against stale rows (see settleRemovalNotice, which drops a removal's
  // confirmation when the reload comes back with the removed rows still in it).
  const shownToken = entry && entry.key === key ? entry.token : hit !== undefined ? token : null;
  const loading = shownToken !== token && error == null;

  useEffect(() => {
    const hit = lookup();
    if (hit !== undefined) {
      cacheTouch(cache, key, { token, data: hit }); // mark most-recently-used
      setEntry({ key, token, data: hit });
      return;
    }

    let cancelled = false;
    // A warm-up already asking for exactly this is waited on, not repeated (see
    // warmCache). If it fails the view asks for itself, as it would have done
    // had there been no warm-up.
    const warm = warmRequest(cache, key, token);
    (warm ? warm.catch(() => fetcher()) : fetcher())
      .then((res) => {
        if (cancelled) return;
        cacheTouch(cache, key, { token, data: res });
        setEntry({ key, token, data: res });
      })
      .catch((e) => !cancelled && setErr({ id: `${key}:${token}`, message: errorMessage(e) }));
    return () => {
      cancelled = true;
    };
    // cache/fetcher are intentionally omitted: key + token identify the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, token]);

  return { data, loading, error };
}
