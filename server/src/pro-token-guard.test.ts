import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb } from "./test-db.js";

// A hosted Pro instance may not run with everyone as the owner.
//
// What is pinned here is not the boolean but where it sits. Pro's owner-facing
// routes are gated on ADMIN_TOKEN, and with no token isAdminRequest answers
// true for every caller — survivable only while "no token" implied "loopback,
// so only this machine". A master breaks that implication deliberately:
// pro/Caddyfile.pro.example exempts /api/pro from the edge login, because a
// spoke's bearer token and HTTP basic auth want the same header. A loopback
// bind behind that proxy is the public internet reaching fourteen ungated owner
// routes, with nothing reporting a problem.
//
// Asserted through start(), because the failure being prevented is one of
// placement. A check that ran after loadPro, or after the bind, would satisfy
// any unit test of the condition itself and still be wrong in a way that
// matters: loadPro awaits init(), which writes Pro's schema into the operator's
// database and arms its sweep, so refusing afterwards has already changed the
// database for a configuration the server then declines to run.

// Both must be unset before config.ts is evaluated — it reads process.env once,
// at module scope. This is the hosted, tokenless Pro shape.
delete process.env.SCIBRARIAN_DESKTOP;
process.env.ADMIN_TOKEN = "";
// A safety net, not a fixture. Nothing here should reach app.listen; if a
// regression lets it, an OS-assigned port fails this file rather than seizing
// 3001 from whatever else is using it.
process.env.PORT = "0";

// proInstalled cannot answer honestly in this runner: it asks
// import.meta.resolve, which vite does not provide, so the real one reports "no
// Pro installed" and start() would skip the branch under test. Stubbed to the
// smallest thing that says "this build has Pro" — and loadPro throws rather
// than returning a module, because reaching it at all is the failure: it is
// what runs init().
// Mutable so the free case below can flip it. The env this file sets — no
// token, not desktop — is the free build's shape too, so the only thing
// separating the two cases is whether a Pro module is present.
let proIsInstalled = true;

vi.mock("./pro-hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pro-hooks.js")>();
  return {
    ...actual,
    proInstalled: () => proIsInstalled,
    loadPro: async () => {
      throw new Error("loadPro was called: the guard did not run before it");
    },
  };
});

beforeAll(async () => {
  await openTempDb("pro-token-guard");
});

afterAll(() => {
  closeTempDb();
  vi.restoreAllMocks();
});

describe("a hosted Pro instance with no ADMIN_TOKEN", () => {
  beforeEach(() => {
    proIsInstalled = true;
  });

  it("refuses to start", async () => {
    const { start } = await import("./index.js");
    await expect(start()).rejects.toThrow(/Refusing to start/);
  });

  it("says what is wrong and which file fixes it", async () => {
    const { start } = await import("./index.js");
    // Resolution is itself a failure, turned into an Error so the assertions
    // below report the configuration being accepted rather than a type error.
    const err = await start().then(
      () => new Error("start() resolved; it must refuse this configuration"),
      (e: unknown) => e as Error
    );
    expect(err.message).toMatch(/ADMIN_TOKEN is not set/);
    expect(err.message).toMatch(/server\/\.env/);
    // Names Pro as the reason, which is also how the free case stays visibly
    // uncovered. A free build has always been allowed to run tokenless on
    // loopback and that is most of the installed base; hoisting this check out
    // of the `if (pro)` branch to "simplify" it would refuse every one of them.
    expect(err.message).toMatch(/Pro build/);
  });

  it("refuses before the module is loaded, not after", async () => {
    const { start } = await import("./index.js");
    // The stub's loadPro throws its own message. Getting that one instead would
    // mean init() had already run — Pro's tables written into the operator's
    // database, its sweep armed — before the server said no.
    await expect(start()).rejects.not.toThrow(/was called/);
  });
});

// The other half of the condition, which used to be structural and is not any
// more. While the check lived inside `if (pro)`, a build with no Pro module
// could not reach it whatever the condition said; asking proInstalled() ahead
// of loadPro moved that guarantee into a value, so it is asserted rather than
// assumed. A free build has always been allowed to run tokenless on loopback
// and that is most of the installed base — refusing them would be the worst
// regression this file could miss.
describe("a free build with no ADMIN_TOKEN", () => {
  beforeEach(() => {
    proIsInstalled = false;
  });

  it("is allowed to start tokenless", async () => {
    const { start } = await import("./index.js");
    // Getting the stub's own error is the pass: execution ran *past* the guard
    // and reached loadPro. Asserting on the tripwire rather than on a completed
    // start() keeps this cheap — a start() that returns goes on to bind a port,
    // arm the cron schedule and fetch the journal catalog over the network.
    await expect(start()).rejects.toThrow(/loadPro was called/);
  });

  it("is not refused for the reason a Pro build would be", async () => {
    const { start } = await import("./index.js");
    await expect(start()).rejects.not.toThrow(/Refusing to start/);
  });
});
