import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb } from "./test-db.js";

// The desktop half of the tokenless-Pro refusal — the half that explains why
// the check is keyed on packaging at all.
//
// The packaged app is a Pro build that deliberately runs with no ADMIN_TOKEN:
// electron/main.mjs sets SCIBRARIAN_DESKTOP=1 and ADMIN_TOKEN="" together,
// because "one local user" is the truth there rather than an omission. So the
// guard in index.ts has two jobs, and pro-token-guard.test.ts only ever pinned
// one of them: that file deletes SCIBRARIAN_DESKTOP before config is read, so
// nothing exercised the branch that keeps every packaged build alive.
//
// What that left open: simplifying the condition to `!ADMIN_TOKEN`, or renaming
// the variable main.mjs sets, would kill every desktop Pro build at startup
// behind main.mjs's "Refusing to start" dialog — with the whole suite green,
// because no test ran as a desktop build.

// Set before config.ts is evaluated; it reads process.env once, at module
// scope. This is the packaged-desktop shape, and the same "1" main.mjs writes.
process.env.SCIBRARIAN_DESKTOP = "1";
process.env.ADMIN_TOKEN = "";
// Cleared so the loopback guard ahead of this one cannot be what answers.
delete process.env.HOST;
// A safety net, not a fixture: the stub below stops start() before it binds, and
// an OS-assigned port fails this file rather than seizing 3001 if one ever does.
process.env.PORT = "0";

// Stubbed as in the hosted file, and read the other way round. proInstalled
// cannot answer honestly under vite, which provides no import.meta.resolve; and
// loadPro throws so that reaching it is observable. There, reaching it was the
// failure. Here it is the pass: this configuration must get past the guard.
vi.mock("./pro-hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pro-hooks.js")>();
  return {
    ...actual,
    proInstalled: () => true,
    loadPro: async () => {
      throw new Error("loadPro was called: the guard did not run before it");
    },
  };
});

beforeAll(async () => {
  await openTempDb("pro-token-guard-desktop");
});

afterAll(() => {
  closeTempDb();
  vi.restoreAllMocks();
});

describe("a packaged desktop Pro build with no ADMIN_TOKEN", () => {
  it("is allowed to start", async () => {
    const { start } = await import("./index.js");
    // Getting the stub's own error is the pass: execution ran past the guard and
    // reached loadPro. Asserting on the tripwire rather than on a completed
    // start() keeps this cheap — a start() that returns goes on to bind a port,
    // arm the cron schedule and fetch the journal catalog over the network.
    await expect(start()).rejects.toThrow(/loadPro was called/);
  });

  it("is not refused the way a hosted instance would be", async () => {
    const { start } = await import("./index.js");
    await expect(start()).rejects.not.toThrow(/Refusing to start/);
  });
});
