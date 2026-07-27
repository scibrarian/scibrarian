import { useEffect, useState } from "react";
import { api } from "../api";

// pmid -> abstract text ("" when the paper has none stored, or the fetch
// failed). Module-level, like the other caches here, so scrolling away and back
// — or flipping to the table and returning — repaints from memory rather than
// refetching text that hasn't changed.
const cache = new Map<string, string>();

// The abstracts for the papers currently rendered, fetched in one request per
// chunk instead of one per card.
//
// Cards used to fetch their own, which meant 50 requests each time the timeline
// grew a page; browsers cap concurrent connections to a host at around six, so
// the later cards' text arrived seconds after the first card's. Asking once for
// the whole chunk collapses that into a single round trip.
//
// A pmid absent from the returned map is still loading, which is what the card
// renders its skeleton for. `pmids` is expected to be the rendered chunk, so it
// stays a URL-friendly length (the timeline's page size is 50).
export function useAbstracts(pmids: string[]): ReadonlyMap<string, string> {
  const [resolved, setResolved] = useState<ReadonlyMap<string, string>>(cache);
  // The identity of `pmids` changes every render; its contents are what matter.
  const key = pmids.join(",");

  useEffect(() => {
    const missing = pmids.filter((p) => !cache.has(p));
    if (missing.length === 0) {
      // Still publish the cache: a chunk whose text was all fetched earlier
      // must not be left waiting on a request that will never be made.
      setResolved(new Map(cache));
      return;
    }
    let cancelled = false;
    // A failed fetch is recorded as "no abstract" rather than retried: the card
    // reads fine without one, and a per-card error banner would be noise.
    const settle = (found: Record<string, string>) => {
      for (const pmid of missing) cache.set(pmid, found[pmid] ?? "");
      if (!cancelled) setResolved(new Map(cache));
    };
    api
      .getAbstracts(missing)
      .then((res) => settle(res.abstracts))
      .catch(() => settle({}));
    return () => {
      cancelled = true;
    };
    // `key` stands in for the pmid list; api is a module singleton.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return resolved;
}
