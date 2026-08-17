import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
// placement. A check that ran before loadPro, after the bind, or outside the
// `if (pro)` branch would satisfy any unit test of the condition itself and
// still be wrong in a way that matters.

// Both must be unset before config.ts is evaluated — it reads process.env once,
// at module scope. This is the hosted, tokenless Pro shape.
delete process.env.SCIBRARIAN_DESKTOP;
process.env.ADMIN_TOKEN = "";
// A safety net, not a fixture. Nothing here should reach app.listen; if a
// regression lets it, an OS-assigned port fails this file rather than seizing
// 3001 from whatever else is using it.
process.env.PORT = "0";

// loadPro cannot answer honestly in this runner: it asks import.meta.resolve,
// which vite does not provide, so the real one reports "no Pro installed" and
// start() would skip the entire branch under test. Stubbed to the smallest
// thing that says "this checkout has Pro" — and routes() throws, because the
// guard is meant to fire before anything is mounted.
vi.mock("./pro-hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pro-hooks.js")>();
  return {
    ...actual,
    loadPro: async () => ({
      version: "test",
      init: async () => {},
      routes: () => {
        throw new Error("routes() was mounted: the guard did not run before it");
      },
    }),
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
    expect(err.message).toMatch(/Pro module is loaded/);
  });

  it("refuses before mounting the Pro routes, not after", async () => {
    const { start } = await import("./index.js");
    // The stub's routes() throws its own message. Getting that one instead
    // would mean the guard ran too late to have prevented anything.
    await expect(start()).rejects.not.toThrow(/was mounted/);
  });
});
