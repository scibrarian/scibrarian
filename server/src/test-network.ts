import path from "node:path";
import { fileURLToPath } from "node:url";
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

// This file's own directory, which is server/src. A test is guarded when its
// file is inside it. Searching the test's path for "/server/src/" instead also
// guarded the client's and Pro's tests in a checkout that sat under another
// server/src.
const SERVER_SRC = path.dirname(fileURLToPath(import.meta.url));

function guarded(): boolean {
  const test = expect.getState().testPath;
  if (test == null) return false;
  const within = path.relative(SERVER_SRC, test);
  return within !== "" && !within.startsWith("..") && !path.isAbsolute(within);
}

// Asked whether the test is guarded before anything else, so a test that isn't
// gets the platform's fetch untouched. A URL that doesn't parse goes to it as
// well, and is rejected there, where parsing it here threw before fetch could
// return the promise its caller was waiting to catch.
globalThis.fetch = (input, init) => {
  if (!guarded()) return realFetch(input, init);
  const url = URL.parse(input instanceof Request ? input.url : input);
  if (url && !LOCAL.has(url.hostname)) {
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
        "Fake the module that asked: PubMed and iCite with test-pubmed.ts, anything else with vi.mock."
    );
  }
}

afterEach(noneTried);
afterAll(noneTried);
