import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN_REJECTED } from "../../shared/auth";
import { api, getAdminToken, setAdminToken, setAuthRejectedHandler } from "./api";

// Whose 401 is this? — the one decision in req(), and the one that used to be
// answered by a header the app does not control.
//
// Getting it wrong in the discarding direction has no exit for the owner: the
// token is gone from localStorage, the UI is back in viewer mode, and the thing
// that caused it (a rotated site password making the edge challenge an
// already-open tab) has nothing to do with the token that was thrown away.
//
// The runner is node with neither localStorage nor a server, so both are
// stubbed. That is not a DOM: it is a Map and a function, which is all this
// decision touches.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

// One reply, however the caller wants it shaped. `headers` exists so a proxied
// 401 — ours, forwarded by an edge that adds a challenge — can be built.
function replyWith(body: string, init: ResponseInit) {
  vi.stubGlobal("fetch", async () => new Response(body, init));
}

const OURS = JSON.stringify({ error: "Admin access required.", code: ADMIN_TOKEN_REJECTED });
const JSON_401: ResponseInit = { status: 401, headers: { "content-type": "application/json" } };

let rejected = 0;

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  rejected = 0;
  setAuthRejectedHandler(() => {
    rejected++;
  });
  setAdminToken("a-good-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The call is arbitrary: every request goes through the same req().
const call = () => api.getTopics().catch(() => undefined);

describe("a 401 the admin gate sent", () => {
  it("drops the stored token and demotes the UI", async () => {
    replyWith(OURS, JSON_401);
    await call();
    expect(getAdminToken()).toBeNull();
    expect(rejected).toBe(1);
  });

  // The case the old test could not have: a challenge on a 401 that is still
  // ours. An edge that attaches WWW-Authenticate to what it forwards used to
  // make this look like someone else's refusal, and the token survived a
  // rotation that had genuinely invalidated it.
  it("is still ours when an edge adds a challenge to it", async () => {
    replyWith(OURS, {
      status: 401,
      headers: { "content-type": "application/json", "WWW-Authenticate": 'Basic realm="site"' },
    });
    await call();
    expect(getAdminToken()).toBeNull();
    expect(rejected).toBe(1);
  });
});

describe("a 401 from something else", () => {
  it("leaves the token alone when the body is an edge's HTML", async () => {
    replyWith("<html><body>401 Unauthorized</body></html>", {
      status: 401,
      headers: { "content-type": "text/html" },
    });
    await call();
    expect(getAdminToken()).toBe("a-good-token");
    expect(rejected).toBe(0);
  });

  it("leaves it alone for a JSON 401 that is not the gate's", async () => {
    replyWith(JSON.stringify({ error: "Not a paired node." }), JSON_401);
    await call();
    expect(getAdminToken()).toBe("a-good-token");
    expect(rejected).toBe(0);
  });

  // Nothing about a 403 says the token is wrong, and the gate never sends one.
  it("leaves it alone on a status that is not 401", async () => {
    replyWith(OURS, { status: 403, headers: { "content-type": "application/json" } });
    await call();
    expect(getAdminToken()).toBe("a-good-token");
    expect(rejected).toBe(0);
  });
});
