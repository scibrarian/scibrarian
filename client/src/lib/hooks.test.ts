// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  useCachedFetch,
  useMediaQuery,
  useRecent,
  useReveal,
  warmCache,
  type FetchCache,
} from "./hooks";

afterEach(cleanup);

type Props = { key: string; token: number };
const emptyCache = (): FetchCache<string> => new Map();

// Every test drives the hook through the two props that identify a request, so
// a case reads as the sequence of views it is actually about.
function mount(cache: FetchCache<string>, fetcher: () => Promise<string>, initial: Props) {
  const seen: { data: string | null; loading: boolean; error: string | null; token: number }[] = [];
  const view = renderHook(
    ({ key, token }: Props) => {
      const r = useCachedFetch(cache, key, token, fetcher);
      seen.push({ ...r, token });
      return r;
    },
    { initialProps: initial }
  );
  return { ...view, seen };
}

describe("useCachedFetch", () => {
  it("reports loading until the answer arrives", async () => {
    const fetcher = vi.fn(async () => "first");
    const { result } = mount(emptyCache(), fetcher, { key: "a", token: 0 });

    expect(result.current).toEqual({ data: null, loading: true, error: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe("first");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves a warm cache without asking again", async () => {
    // The flash this exists to stop: returning to a cached source used to
    // render one null frame before the cached data appeared.
    const cache = emptyCache();
    cache.set("a", { token: 0, data: "cached" });
    const fetcher = vi.fn(async () => "fetched");
    const { result } = mount(cache, fetcher, { key: "a", token: 0 });

    expect(result.current).toEqual({ data: "cached", loading: false, error: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("holds the previous answer on screen while a bumped token refetches", async () => {
    // Both halves matter and they used to disagree. The previous answer stays
    // put so a reload doesn't flash a skeleton — and `loading` says so, rather
    // than reporting the reload landed over contents that are still the old
    // ones.
    const fetcher = vi.fn<() => Promise<string>>();
    fetcher.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const cache = emptyCache();
    const { result, rerender } = mount(cache, fetcher, { key: "a", token: 0 });

    await waitFor(() => expect(result.current.data).toBe("first"));
    rerender({ key: "a", token: 1 });
    expect(result.current).toEqual({ data: "first", loading: true, error: null });

    await waitFor(() => expect(result.current.data).toBe("second"));
    expect(result.current.loading).toBe(false);
  });

  it("never reports loaded while the previous token's answer is what's on screen", async () => {
    // The invariant the rest of the client reads this hook through: whenever
    // `loading` is false and there is no error, `data` is *this* token's answer.
    // It was breakable because `data` matches on the key alone while `loading`
    // came from a lookup matching on key and token, and cacheTouch writes to the
    // cache a render before setEntry commits.
    const answers: Record<number, string> = { 0: "first", 1: "second", 2: "third" };
    let calls = 0;
    const fetcher = vi.fn(async () => answers[calls++]);
    const { result, rerender, seen } = mount(emptyCache(), fetcher, { key: "a", token: 0 });

    await waitFor(() => expect(result.current.data).toBe("first"));
    rerender({ key: "a", token: 1 });
    await waitFor(() => expect(result.current.data).toBe("second"));
    rerender({ key: "a", token: 2 });
    await waitFor(() => expect(result.current.data).toBe("third"));

    expect(seen.length).toBeGreaterThan(3);
    for (const s of seen) {
      if (!s.loading && s.error == null) expect(s.data).toBe(answers[s.token]);
    }
  });

  it("doesn't report loaded because another consumer filled the cache", async () => {
    // The way that invariant actually breaks. Two views share a cache — the
    // papers list and the MeSH facets do — so one of them can write this key's
    // new answer into the Map while the other's own request is still out.
    // cacheTouch writes synchronously; the reader's `entry` only catches up when
    // its own fetch commits. In between, a lookup keyed on (key, token) says the
    // answer is here while `data` is still the previous token's.
    const cache = emptyCache();
    cache.set("a", { token: 0, data: "first" });
    const filler = vi.fn(async () => "second");
    const stuck = vi.fn(() => new Promise<string>(() => {}));

    const a = renderHook(
      ({ token }: { token: number }) => useCachedFetch(cache, "a", token, filler),
      { initialProps: { token: 0 } }
    );
    const b = renderHook(
      ({ token }: { token: number; nonce: number }) => useCachedFetch(cache, "a", token, stuck),
      { initialProps: { token: 0, nonce: 0 } }
    );
    await waitFor(() => expect(b.result.current.data).toBe("first"));

    a.rerender({ token: 1 });
    b.rerender({ token: 1, nonce: 0 });
    await waitFor(() => expect(a.result.current.data).toBe("second"));
    expect(cache.get("a")).toEqual({ token: 1, data: "second" });

    // Any unrelated render of the second consumer now reads that fresh entry
    // out of the cache while still showing the stale one.
    b.rerender({ token: 1, nonce: 1 });
    expect(b.result.current.data).toBe("first");
    expect(b.result.current.loading).toBe(true);
  });

  it("shows nothing from the key it just left", async () => {
    // A source switch is not a reload: the previous source's papers are not a
    // worse version of this one's, they are the wrong ones.
    const fetcher = vi.fn<() => Promise<string>>();
    fetcher.mockResolvedValueOnce("from a").mockResolvedValueOnce("from b");
    const { result, rerender } = mount(emptyCache(), fetcher, { key: "a", token: 0 });

    await waitFor(() => expect(result.current.data).toBe("from a"));
    rerender({ key: "b", token: 0 });
    expect(result.current).toEqual({ data: null, loading: true, error: null });
    await waitFor(() => expect(result.current.data).toBe("from b"));
  });

  it("reports a failure, and stops calling itself loading", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("Couldn't load.");
    });
    const { result } = mount(emptyCache(), fetcher, { key: "a", token: 0 });

    await waitFor(() => expect(result.current.error).toBe("Couldn't load."));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
  });

  it("clears a failure implicitly when the token is bumped to retry", async () => {
    const fetcher = vi.fn<() => Promise<string>>();
    fetcher.mockRejectedValueOnce(new Error("Couldn't load.")).mockResolvedValueOnce("worked");
    const { result, rerender } = mount(emptyCache(), fetcher, { key: "a", token: 0 });

    await waitFor(() => expect(result.current.error).toBe("Couldn't load."));
    rerender({ key: "a", token: 1 });
    // Keyed by (key, token), so the retry doesn't have to clear it by hand.
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.data).toBe("worked"));
  });

  it("doesn't leak a failure across a key change", async () => {
    const fetcher = vi.fn<() => Promise<string>>();
    fetcher.mockRejectedValueOnce(new Error("Couldn't load.")).mockResolvedValueOnce("from b");
    const { result, rerender } = mount(emptyCache(), fetcher, { key: "a", token: 0 });

    await waitFor(() => expect(result.current.error).toBe("Couldn't load."));
    rerender({ key: "b", token: 0 });
    expect(result.current.error).toBeNull();
  });

  it("evicts the least recently used entry once the cache is full", async () => {
    // Every distinct search prefix mints a key, so a long session would
    // otherwise pin unbounded responses in memory.
    const cache = emptyCache();
    for (let i = 0; i < 30; i++) cache.set(`k${i}`, { token: 0, data: `d${i}` });
    const fetcher = vi.fn(async () => "new");
    const { result } = mount(cache, fetcher, { key: "fresh", token: 0 });

    await waitFor(() => expect(result.current.data).toBe("new"));
    expect(cache.size).toBe(30);
    expect(cache.has("k0")).toBe(false);
    expect(cache.has("fresh")).toBe(true);
  });

  it("keeps a re-read entry from being the next one evicted", async () => {
    // The hit branch touches the cache as well as reading it, which is what
    // makes Map order track recency rather than insertion.
    const cache = emptyCache();
    for (let i = 0; i < 30; i++) cache.set(`k${i}`, { token: 0, data: `d${i}` });
    const fetcher = vi.fn(async () => "new");

    // Read the oldest entry, which moves it to the back of the queue...
    const first = mount(cache, fetcher, { key: "k0", token: 0 });
    await waitFor(() => expect(first.result.current.data).toBe("d0"));
    cleanup();
    // ...so the next eviction takes k1 instead.
    const second = mount(cache, fetcher, { key: "fresh", token: 0 });
    await waitFor(() => expect(second.result.current.data).toBe("new"));

    expect(cache.has("k0")).toBe(true);
    expect(cache.has("k1")).toBe(false);
  });
});

describe("warmCache", () => {
  // A request the test settles by hand, so a view can be stood up while it is
  // still out.
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("files the answer where a view's first render finds it", async () => {
    const cache = emptyCache();
    await warmCache(cache, "a", 0, async () => "warmed");

    const fetcher = vi.fn(async () => "fetched");
    const { result } = mount(cache, fetcher, { key: "a", token: 0 });
    expect(result.current).toEqual({ data: "warmed", loading: false, error: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is waited on by a view that mounts before it lands, not asked again", async () => {
    // The slow case, which is the one a warm-up is for: its caller has stopped
    // waiting and put the view up. The view used to miss the cache, ask the
    // server for the same thing, and then ignore the warm answer when it came.
    const cache = emptyCache();
    const out = deferred<string>();
    const warm = vi.fn(() => out.promise);
    void warmCache(cache, "a", 0, warm);

    const fetcher = vi.fn(async () => "fetched");
    const { result } = mount(cache, fetcher, { key: "a", token: 0 });
    expect(result.current).toEqual({ data: null, loading: true, error: null });

    out.resolve("warmed");
    await waitFor(() => expect(result.current.data).toBe("warmed"));
    expect(result.current.loading).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("leaves the view to ask for itself when it fails", async () => {
    const cache = emptyCache();
    const out = deferred<string>();
    const warmed = warmCache(cache, "a", 0, () => out.promise);
    const fetcher = vi.fn(async () => "fetched");
    const { result } = mount(cache, fetcher, { key: "a", token: 0 });

    out.reject(new Error("Couldn't load."));
    // Resolves either way, with nothing filed.
    await warmed;
    expect(cache.has("a")).toBe(false);

    await waitFor(() => expect(result.current.data).toBe("fetched"));
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("is not waited on by a view reading another token", async () => {
    // The source was bumped after the warm-up went out, so its answer is the
    // previous token's and the view has to ask for this one.
    const cache = emptyCache();
    void warmCache(cache, "a", 0, () => new Promise<string>(() => {}));

    const fetcher = vi.fn(async () => "fetched");
    const { result } = mount(cache, fetcher, { key: "a", token: 1 });
    await waitFor(() => expect(result.current.data).toBe("fetched"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("asks once for two warm-ups of the same key", async () => {
    const cache = emptyCache();
    const out = deferred<string>();
    const fetcher = vi.fn(() => out.promise);
    const first = warmCache(cache, "a", 0, fetcher);
    const second = warmCache(cache, "a", 0, fetcher);

    out.resolve("warmed");
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.get("a")).toEqual({ token: 0, data: "warmed" });
  });

  it("asks again after a failure, rather than handing on the dead request", async () => {
    const cache = emptyCache();
    const fetcher = vi.fn<() => Promise<string>>();
    fetcher.mockRejectedValueOnce(new Error("Couldn't load.")).mockResolvedValueOnce("warmed");

    await warmCache(cache, "a", 0, fetcher);
    expect(cache.has("a")).toBe(false);
    await warmCache(cache, "a", 0, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.get("a")).toEqual({ token: 0, data: "warmed" });
  });
});

// The three hooks below answer for an input that can change under them, and
// each used to answer for the previous one on the render that first saw the
// change. A test of what the hook settles on can't see that — the effect has
// corrected it by the time the assertion runs — so these keep every render.
function watch<P, R>(hook: (props: P) => R, initial: P) {
  const seen: { props: P; value: R }[] = [];
  const view = renderHook(
    (props: P) => {
      const value = hook(props);
      seen.push({ props, value });
      return value;
    },
    { initialProps: initial }
  );
  return { ...view, seen };
}

// jsdom has no matchMedia. This stands one up: the queries passed in match,
// and `set` moves one in or out and tells its listeners, as a resize across
// the breakpoint would.
function stubMatchMedia(...initial: string[]) {
  const matching = new Set(initial);
  const listeners = new Map<string, Set<() => void>>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      get matches() {
        return matching.has(query);
      },
      addEventListener: (_: string, fn: () => void) => {
        if (!listeners.has(query)) listeners.set(query, new Set());
        listeners.get(query)!.add(fn);
      },
      removeEventListener: (_: string, fn: () => void) => {
        listeners.get(query)?.delete(fn);
      },
    }),
  });
  return {
    set(query: string, on: boolean) {
      if (on) matching.add(query);
      else matching.delete(query);
      listeners.get(query)?.forEach((fn) => fn());
    },
  };
}

describe("useMediaQuery", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  const NARROW = "(max-width: 780px)";
  const MEDIUM = "(max-width: 1024px)";
  const media = (query: string) =>
    watch((p: { query: string }) => useMediaQuery(p.query), { query });

  it("is false where there is no matchMedia", () => {
    expect(media(NARROW).result.current).toBe(false);
  });

  it("follows the query as the viewport crosses it", () => {
    const viewport = stubMatchMedia();
    const { result } = media(NARROW);
    expect(result.current).toBe(false);

    act(() => viewport.set(NARROW, true));
    expect(result.current).toBe(true);
    act(() => viewport.set(NARROW, false));
    expect(result.current).toBe(false);
  });

  it("answers for the query it has now, not the one it mounted with", () => {
    // A 900px viewport: past the first breakpoint, inside the second. The
    // answer used to stay the first query's until a resize crossed the second.
    stubMatchMedia(MEDIUM);
    const { rerender, seen } = media(NARROW);
    const from = seen.length;

    rerender({ query: MEDIUM });
    expect(seen.slice(from).map((s) => s.value)).not.toContain(false);
  });
});

describe("useRecent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const recent = (key: string) => watch((p: { key: string }) => useRecent(p.key, 300), { key });
  const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it("is true from mount until the window has passed", () => {
    const { result } = recent("a");
    expect(result.current).toBe(true);
    pass(299);
    expect(result.current).toBe(true);
    pass(1);
    expect(result.current).toBe(false);
  });

  it("answers for a new key on the render that first sees it", () => {
    // The clock restarts in an effect, a commit after the key changes; the
    // render in between used to get the previous key's expired answer.
    const { result, rerender, seen } = recent("a");
    pass(300);
    const from = seen.length;

    rerender({ key: "b" });
    expect(seen.slice(from).map((s) => s.value)).not.toContain(false);
    pass(300);
    expect(result.current).toBe(false);
  });

  it("is recent again on a return to a key whose window had passed", () => {
    // What keeping the key beside the flag has to get right: `a` expired once,
    // and coming back to it is a change of key like any other.
    const { result, rerender, seen } = recent("a");
    pass(300);
    rerender({ key: "b" });
    const from = seen.length;

    rerender({ key: "a" });
    expect(seen.slice(from).map((s) => s.value)).not.toContain(false);
    pass(300);
    expect(result.current).toBe(false);
  });
});

describe("useReveal", () => {
  type Props = { ready: boolean; key: string };
  const reveal = (initial: Props) => watch((p: Props) => useReveal(p.ready, p.key), initial);

  // No View Transition API in jsdom, so the swap is committed plainly (see
  // commitWithFade) — except where a test stands the API up to hold a
  // transition's callback back, as the browser does for a frame.
  function holdTransitions() {
    stubMatchMedia();
    const held: (() => void)[] = [];
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: (run: () => void) => void held.push(run),
    });
    return { runNext: () => act(() => held.shift()!()) };
  }
  afterEach(() => {
    Reflect.deleteProperty(document, "startViewTransition");
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("paints at once what is ready when it mounts", () => {
    const { seen } = reveal({ ready: true, key: "a" });
    expect(seen.map((s) => s.value)).not.toContain(false);
  });

  it("holds the stand-in for the render that first sees ready, then swaps", () => {
    const { result, rerender, seen } = reveal({ ready: false, key: "a" });
    const from = seen.length;

    rerender({ ready: true, key: "a" });
    expect(seen[from].value).toBe(false);
    expect(result.current).toBe(true);
  });

  it("answers a fall on the same render", () => {
    const { rerender, seen } = reveal({ ready: true, key: "a" });
    const from = seen.length;

    rerender({ ready: false, key: "a" });
    expect(seen.slice(from).map((s) => s.value)).not.toContain(true);
  });

  it("paints at once a key that is ready when it is switched to", () => {
    // Leaving a source still on its stand-in for one that is cached, or known
    // to be empty. The lag in hand was the first source's, and the second used
    // to be drawn as a stand-in and faded in because of it.
    const { rerender, seen } = reveal({ ready: false, key: "a" });
    const from = seen.length;

    rerender({ ready: true, key: "b" });
    expect(seen.slice(from).map((s) => s.value)).not.toContain(false);
  });

  it("still lags the rise of a key that was not ready when switched to", () => {
    const { result, rerender, seen } = reveal({ ready: true, key: "a" });
    rerender({ ready: false, key: "b" });
    const from = seen.length;

    rerender({ ready: true, key: "b" });
    expect(seen[from].value).toBe(false);
    expect(result.current).toBe(true);
  });

  it("drops a fade that lands after its key was left", () => {
    // `a` turns ready and its transition is queued; before the browser runs
    // it the view has moved to `b`, which then turns ready as well. The late
    // callback must not reveal `b` with a cut, ahead of the fade `b` queued.
    const transitions = holdTransitions();
    const { result, rerender } = reveal({ ready: false, key: "a" });
    rerender({ ready: true, key: "a" });
    rerender({ ready: false, key: "b" });
    rerender({ ready: true, key: "b" });
    expect(result.current).toBe(false);

    transitions.runNext();
    expect(result.current).toBe(false);
    transitions.runNext();
    expect(result.current).toBe(true);
  });
});
