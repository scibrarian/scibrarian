import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb } from "./test-db.js";

// A comma in ADMIN_TOKEN is unrecoverable, so it is refused rather than run.
//
// presentedAdminTokens splits a folded X-Admin-Token back into pieces to find
// ours in it — see routes.ts for why Node folds it in the first place. Splitting
// cannot reassemble a token that contains the separator, so a comma-carrying
// token authenticates perfectly until the day something inserts a second header,
// and then refuses every mutation and gets itself discarded by the client. The
// value works everywhere it is tested and fails only in production.
//
// Asserted through start(), like the Pro guard: what is pinned is that the
// refusal happens before the server is serving, not that a predicate is correct.

// Set before config.ts is evaluated — it reads process.env once, at module
// scope. HOST is cleared so the loopback guard above this one cannot be what
// answers instead.
process.env.ADMIN_TOKEN = "ab,cd";
delete process.env.HOST;
// A safety net, not a fixture: nothing here should reach app.listen, and an
// OS-assigned port fails this file rather than seizing 3001 if one ever does.
process.env.PORT = "0";

beforeAll(async () => {
  await openTempDb("admin-token-comma");
});

afterAll(() => {
  closeTempDb();
});

describe("an ADMIN_TOKEN with a comma in it", () => {
  it("refuses to start", async () => {
    const { start } = await import("./index.js");
    await expect(start()).rejects.toThrow(/Refusing to start/);
  });

  it("says which character is the problem and which file fixes it", async () => {
    const { start } = await import("./index.js");
    // Resolution is itself a failure, turned into an Error so the assertions
    // below report the configuration being accepted rather than a type error.
    const err = await start().then(
      () => new Error("start() resolved; it must refuse this configuration"),
      (e: unknown) => e as Error
    );
    expect(err.message).toMatch(/comma/);
    expect(err.message).toMatch(/server\/\.env/);
    // Not conflated with the token being absent. This one is set, and telling
    // the operator to set it would send them looking at a line that is already
    // there.
    expect(err.message).not.toMatch(/is not set/);
  });
});
