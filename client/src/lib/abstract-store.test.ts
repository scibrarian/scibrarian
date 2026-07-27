import { describe, it, expect } from "vitest";
import { createAbstractStore } from "./abstract-store";

// A fetch that hands back its promise's controls, so each request can be landed
// or failed at the point a test wants it to.
function stubFetch() {
  const calls: string[][] = [];
  const pending: {
    resolve: (found: Record<string, string>) => void;
    reject: (reason: unknown) => void;
  }[] = [];
  return {
    calls,
    pending,
    fetchAbstracts: (pmids: string[]) => {
      calls.push(pmids);
      return new Promise<Record<string, string>>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
  };
}

const asObject = (m: ReadonlyMap<string, string>) => Object.fromEntries(m);

describe("answers", () => {
  it("caches text, and caches a paper the server has no abstract for", async () => {
    const { calls, pending, fetchAbstracts } = stubFetch();
    const store = createAbstractStore(fetchAbstracts);

    const [request] = store.load(["1", "2"]);
    pending[0].resolve({ "1": "an abstract" });
    await request;

    expect(asObject(store.view())).toEqual({ "1": "an abstract", "2": "" });
    // Both are answered, so neither is asked about again.
    expect(store.load(["1", "2"])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("leaves a pmid absent until its request lands", () => {
    const { fetchAbstracts } = stubFetch();
    const store = createAbstractStore(fetchAbstracts);
    store.load(["1"]);
    // Absent, not "" — the card renders a skeleton rather than "no abstract".
    expect(store.view().has("1")).toBe(false);
  });
});

describe("failures", () => {
  it("does not record a failed request as an answer", async () => {
    const { calls, pending, fetchAbstracts } = stubFetch();
    const store = createAbstractStore(fetchAbstracts);

    const [request] = store.load(["1", "2"]);
    pending[0].reject(new Error("offline"));
    await request;

    // Readable on screen…
    expect(asObject(store.view())).toEqual({ "1": "", "2": "" });
    // …but still unknown, so the next chunk asks again. Caching the failure
    // marked all 50 papers of a chunk abstract-less for the whole session.
    store.load(["1", "2"]);
    expect(calls).toEqual([
      ["1", "2"],
      ["1", "2"],
    ]);
  });

  it("replaces the failure once a retry succeeds", async () => {
    const { calls, pending, fetchAbstracts } = stubFetch();
    const store = createAbstractStore(fetchAbstracts);

    const [failing] = store.load(["1", "2"]);
    pending[0].reject(new Error("offline"));
    await failing;

    const [retry] = store.load(["1", "2"]);
    pending[1].resolve({ "1": "arrived late" });
    await retry;

    expect(asObject(store.view())).toEqual({ "1": "arrived late", "2": "" });
    expect(store.load(["1", "2"])).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe("requests in flight", () => {
  it("asks only for the pmids nobody is waiting on", async () => {
    const { calls, pending, fetchAbstracts } = stubFetch();
    const store = createAbstractStore(fetchAbstracts);

    // The timeline grows a page before the first chunk resolves.
    const first = store.load(["1", "2"]);
    const second = store.load(["1", "2", "3", "4"]);

    expect(calls).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    // The overlap is waited on, not re-requested: the same promise comes back.
    expect(second).toHaveLength(2);
    expect(second[0]).toBe(first[0]);

    pending[0].resolve({ "1": "a", "2": "b" });
    pending[1].resolve({ "3": "c" });
    await Promise.all(second);
    expect(asObject(store.view())).toEqual({ "1": "a", "2": "b", "3": "c", "4": "" });
  });

  it("asks again after an in-flight request fails", async () => {
    const { calls, pending, fetchAbstracts } = stubFetch();
    const store = createAbstractStore(fetchAbstracts);

    const [first] = store.load(["1"]);
    store.load(["1"]); // still on the way — no second request
    expect(calls).toHaveLength(1);

    pending[0].reject(new Error("offline"));
    await first;

    store.load(["1"]);
    expect(calls).toEqual([["1"], ["1"]]);
  });
});
