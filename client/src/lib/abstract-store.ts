// One request per rendered chunk of the timeline, shared across every card and
// every remount. Kept apart from the hook in abstracts.ts — and from the api
// module — so the bookkeeping below is plain functions over three maps.
//
// The three states a pmid can be in are what this exists to keep apart:
//
//   settled  the server answered: the abstract text, or "" for a paper that
//            genuinely has none. Never asked for again.
//   inFlight a request covering it is on the way. Not asked for again *yet*,
//            but the caller can wait on that request.
//   failed   its last request errored. Reads as "no abstract" so the card has
//            something to render, but is asked for again next time.
//
// Collapsing failed into settled — writing "" for a chunk whose request threw —
// is what marked 50 papers abstract-less for the rest of a session over one
// dropped connection.
export type FetchAbstracts = (pmids: string[]) => Promise<Record<string, string>>;

export type AbstractStore = {
  // Everything known right now: text per pmid, "" for a paper with no abstract
  // or whose fetch failed. A pmid absent from this map has yet to arrive, which
  // is what a card renders its skeleton for.
  view: () => ReadonlyMap<string, string>;
  // Put every pmid on its way, and hand back the requests still to land so the
  // caller can repaint as each one does. Empty when there's nothing to wait for.
  load: (pmids: string[]) => Promise<void>[];
};

export function createAbstractStore(fetchAbstracts: FetchAbstracts): AbstractStore {
  const settled = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();
  const failed = new Set<string>();

  function request(pmids: string[]): Promise<void> {
    const done = fetchAbstracts(pmids)
      .then((found) => {
        // A pmid the server didn't answer for has no abstract stored: that's an
        // answer, and it caches.
        for (const pmid of pmids) {
          settled.set(pmid, found[pmid] ?? "");
          failed.delete(pmid);
        }
      })
      .catch(() => {
        // Not an answer. Nothing goes into `settled`, so the next load asks
        // again — the per-card code this replaced retried the same way, by
        // never writing its cache on failure.
        for (const pmid of pmids) failed.add(pmid);
      })
      .finally(() => {
        // Only clear entries still pointing at this request: a pmid re-requested
        // after this one failed belongs to the newer attempt.
        for (const pmid of pmids) if (inFlight.get(pmid) === done) inFlight.delete(pmid);
      });
    for (const pmid of pmids) inFlight.set(pmid, done);
    return done;
  }

  function load(pmids: string[]): Promise<void>[] {
    const waits = new Set<Promise<void>>();
    const fresh: string[] = [];
    for (const pmid of pmids) {
      if (settled.has(pmid)) continue;
      // Already on the way: wait on that request rather than opening a second
      // one. Without this, scrolling before a chunk resolves re-asks for every
      // pmid still outstanding — 50 more each page, at a page per scroll.
      const running = inFlight.get(pmid);
      if (running) waits.add(running);
      else fresh.push(pmid);
    }
    if (fresh.length > 0) waits.add(request(fresh));
    return [...waits];
  }

  function view(): ReadonlyMap<string, string> {
    const known = new Map(settled);
    // A paper whose fetch failed reads as one with no abstract — the card is
    // fine without it, and a per-card error banner would be noise. The failure
    // stays out of `settled`, so this is only what's on screen, not a verdict.
    for (const pmid of failed) known.set(pmid, "");
    return known;
  }

  return { view, load };
}
