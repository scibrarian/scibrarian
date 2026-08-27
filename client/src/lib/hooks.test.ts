// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useCachedFetch, type FetchCache } from "./hooks";

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
