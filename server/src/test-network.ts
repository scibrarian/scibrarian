import { afterAll, afterEach, expect } from "vitest";

// No server test reaches the network: a vitest setup file (vitest.config.ts)
// that refuses every request a server test makes to anywhere but this machine.
//
// A test that reached PubMed, NLM, iCite or OpenAlex passed on a fast day and
// failed on a slow one, and CI found it before anyone did. Refusing the request
// isn't enough on its own, because most of what asks is best-effort by design —
// the MEDLINE check, the citation warm-up, a Pro master that may be away — and
// swallows a failed fetch, so the test would still pass, quietly testing the
// outage path. So the test fails as well, from afterEach, naming what it asked
// for.
//
// localhost stays open: the route tests talk to a server they started on
// 127.0.0.1. Client tests mock `api` and Pro's are left to themselves, so only
// server/src is guarded.

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = globalThis.fetch;
let tried: string[] = [];

function guarded(): boolean {
  return (expect.getState().testPath ?? "").replaceAll("\\", "/").includes("/server/src/");
}

globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!LOCAL.has(url.hostname) && guarded()) {
    // Origin and path only: a query to NCBI can carry the reader's API key.
    const where = `${url.origin}${url.pathname}`;
    tried.push(where);
    return Promise.reject(new TypeError(`fetch failed: tests don't reach the network (${where})`));
  }
  return realFetch(input, init);
};

function noneTried(): void {
  const urls = tried;
  tried = [];
  if (urls.length > 0) {
    throw new Error(
      `This test tried to reach the network: ${[...new Set(urls)].join(", ")}. ` +
        "Mock the module that asked, as the tests mocking ./pubmed.js do."
    );
  }
}

afterEach(noneTried);
afterAll(noneTried);
