import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { ALL, FED, FILED, SAVED, seedHoldings } from "./unheld-sweep-fixture.js";

// The sweep of papers nothing holds, at startup: that a start runs it, and
// that a start outlives it when it fails.
//
// What the sweep takes is unheld-sweep.test.ts, and when it runs after a
// removal is unheld-sweep-routes.test.ts. A removal's sweep skips its turn
// while anything is attaching, and the start is what takes whatever those
// skips left. When it fails, the rows it would have deleted are ones nobody can
// see, and a database another process has locked for the length of that one
// delete used to mean a server that didn't come up, or a desktop window that
// never opened.

// Set before config.ts is evaluated; it reads process.env once, at module
// scope. A free build on loopback, which the guards ahead of the sweep let by.
delete process.env.SCIBRARIAN_DESKTOP;
process.env.ADMIN_TOKEN = "";
delete process.env.HOST;
// A safety net, not a fixture: the stub below stops start() before it binds, and
// an OS-assigned port fails this file rather than seizing 3001 if one ever does.
process.env.PORT = "0";

const SWEEP_FAILURE = "database is locked";
const sweep = vi.hoisted(() => ({ fails: false }));

vi.mock("./db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db.js")>();
  return {
    ...actual,
    dropUnheldArticles: () => {
      if (sweep.fails) throw new Error(SWEEP_FAILURE);
      return actual.dropUnheldArticles();
    },
  };
});

// loadPro is what start() does next, and throws so that reaching it is
// observable: the tripwire pro-token-guard.test.ts uses, for the reason given
// there. Getting its error is the pass.
vi.mock("./pro-hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pro-hooks.js")>();
  return {
    ...actual,
    proInstalled: () => false,
    loadPro: async () => {
      throw new Error("loadPro was called");
    },
  };
});

let db: Db;

beforeAll(async () => {
  db = await openTempDb("unheld-sweep-startup");
});

afterAll(() => {
  closeTempDb();
  vi.restoreAllMocks();
});

describe("a start", () => {
  beforeEach(() => {
    sweep.fails = false;
    seedHoldings(db);
  });

  it("takes the papers nothing holds, before Pro is loaded", async () => {
    const { start } = await import("./index.js");
    // Stopped at the tripwire, with the sweep already done: it comes before
    // loadPro, which arms Pro's own sweep and its pulls.
    await expect(start()).rejects.toThrow(/loadPro was called/);
    expect([...db.existingPmids(ALL)].sort()).toEqual([FED, FILED, SAVED]);
  });
});

describe("a start whose sweep of unheld papers fails", () => {
  beforeEach(() => {
    sweep.fails = true;
  });

  it("goes on past it", async () => {
    const { start } = await import("./index.js");
    await expect(start()).rejects.toThrow(/loadPro was called/);
  });

  it("says that it failed, and why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { start } = await import("./index.js");
    await start().catch(() => {});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(SWEEP_FAILURE));
  });
});
