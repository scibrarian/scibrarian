import { useEffect, useState } from "react";
import { api } from "../api";
import { createAbstractStore } from "./abstract-store";

// Module-level, like the other caches here, so scrolling away and back — or
// flipping to the table and returning — repaints from memory rather than
// refetching text that hasn't changed.
const store = createAbstractStore((pmids) =>
  api.getAbstracts(pmids).then((res) => res.abstracts)
);

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
  const [resolved, setResolved] = useState<ReadonlyMap<string, string>>(() => store.view());
  // The identity of `pmids` changes every render; its contents are what matter.
  const key = pmids.join(",");

  useEffect(() => {
    let cancelled = false;
    const publish = () => {
      if (!cancelled) setResolved(store.view());
    };

    const pending = store.load(pmids);
    // Still publish when there's nothing to wait for: a chunk whose text was
    // all fetched earlier must not be left waiting on a request that will never
    // be made. Otherwise each request repaints as it lands, so a chunk that
    // spans two of them fills in progressively.
    if (pending.length === 0) publish();
    else for (const request of pending) void request.then(publish);

    // Cancelling only suppresses *this* run's repaint. The requests themselves
    // run on in the store, and whichever run supersedes this one waits on the
    // same promises — so an abandoned chunk can't strand its cards on skeletons.
    return () => {
      cancelled = true;
    };
    // `key` stands in for the pmid list; the store is a module singleton.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return resolved;
}
