import { describe, it, expect } from "vitest";
import { NO_RELOADS, bumpAll, bumpSource, tokenFor, type ReloadTokens } from "./reload";

// A cached entry is served when the token it was stamped with still matches the
// source's current one — the rule in useCachedFetch, restated here because it's
// what every assertion below is really about.
const cached = (at: ReloadTokens, key: string) => {
  const stamped = tokenFor(at, key);
  return (now: ReloadTokens) => tokenFor(now, key) === stamped;
};

describe("tokenFor", () => {
  it("starts every source on the same token", () => {
    expect(tokenFor(NO_RELOADS, "t1")).toBe(tokenFor(NO_RELOADS, "f2"));
  });
});

describe("bumpSource", () => {
  it("invalidates the bumped source", () => {
    const entry = cached(NO_RELOADS, "f2");
    expect(entry(bumpSource(NO_RELOADS, "f2"))).toBe(false);
  });

  // The point of the whole module: saving a paper into a folder you aren't
  // looking at must not cost the topic you are looking at its cached papers.
  it("leaves every other source cached", () => {
    const topic = cached(NO_RELOADS, "t1");
    const collection = cached(NO_RELOADS, "c1");
    const after = bumpSource(NO_RELOADS, "f2");
    expect(topic(after)).toBe(true);
    expect(collection(after)).toBe(true);
  });

  it("doesn't mutate the state it was given", () => {
    const before = bumpSource(NO_RELOADS, "f2");
    const snapshot = tokenFor(before, "f2");
    bumpSource(before, "f2");
    expect(tokenFor(before, "f2")).toBe(snapshot);
  });
});

describe("bumpAll", () => {
  it("invalidates every source, bumped or not", () => {
    const bumped = cached(NO_RELOADS, "f2");
    const untouched = cached(NO_RELOADS, "t1");
    const after = bumpAll(bumpSource(NO_RELOADS, "f2"));
    expect(bumped(after)).toBe(false);
    expect(untouched(after)).toBe(false);
  });
});

// Tokens are compared for equality, so a value that came round again would
// serve a dead source's papers to whatever inherits its id. Interleaving the
// two kinds of bump is what could produce one: they move separate counters.
it("never reissues a token a source has already held", () => {
  const f2 = (t: ReloadTokens) => bumpSource(t, "f2");
  const other = (t: ReloadTokens) => bumpSource(t, "t1");
  const steps: [(t: ReloadTokens) => ReloadTokens, boolean][] = [
    [f2, true],
    [other, false],
    [bumpAll, true],
    [f2, true],
    [bumpAll, true],
    [other, false],
    [f2, true],
  ];

  let tokens = NO_RELOADS;
  let last = tokenFor(tokens, "f2");
  for (const [bump, reaches] of steps) {
    tokens = bump(tokens);
    const token = tokenFor(tokens, "f2");
    // Strictly rising when the bump reaches f2, untouched when it doesn't:
    // together, no value is ever handed out twice.
    if (reaches) expect(token).toBeGreaterThan(last);
    else expect(token).toBe(last);
    last = token;
  }
});
