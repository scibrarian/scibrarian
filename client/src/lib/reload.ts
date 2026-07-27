// Invalidation tokens for the view caches (papers, graph, collection files).
// All three are keyed by source, so what a view compares against is the token
// for *its* source: a change to one source must not throw away every other
// one's cached list, because refetching /api/papers waits on an iCite citation
// backfill before it answers. A single global counter did exactly that — one
// bookmark toggle left every topic and collection to reload from scratch.
//
// `all` covers the changes that genuinely reach everything, and doubles as the
// safe answer for a deleted source: SQLite hands out row ids again after a
// delete, so a newly created folder can inherit a dead one's key — and with it,
// its cache entries.
//
// Both counters only ever rise, so a stale entry's token can never come back
// around to match a later one for the same source.
export type ReloadTokens = { all: number; bySource: Record<string, number> };

export const NO_RELOADS: ReloadTokens = { all: 0, bySource: {} };

// The current token for one source key (see sourceKey: "t3" / "f2" / "c1").
export function tokenFor(tokens: ReloadTokens, key: string): number {
  return tokens.all + (tokens.bySource[key] ?? 0);
}

// One source's data changed; every other source's cache stays valid.
export function bumpSource(tokens: ReloadTokens, key: string): ReloadTokens {
  const bySource = { ...tokens.bySource, [key]: (tokens.bySource[key] ?? 0) + 1 };
  return { ...tokens, bySource };
}

// A change no single source owns: a poll across every topic, papers removed
// from Interests wholesale, or a source deleted.
export function bumpAll(tokens: ReloadTokens): ReloadTokens {
  return { ...tokens, all: tokens.all + 1 };
}
