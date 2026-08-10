import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgHolding, ProStatus } from "../../shared/pro.js";
import { proStatus, pulledOrgByPmid, registerPro, type ProModule } from "./pro-hooks.js";

// What the seam does when the Pro module misbehaves.
//
// The accessors in pro-hooks are the only place the free tier touches paid
// code, and each one has to decide what a failure means. That decision is not
// uniform, which is the point of testing it here rather than assuming a house
// rule: a hook whose absence is *invisible* should contain its errors, and a
// hook whose absence is a *claim about what the customer bought* must not.
//
// No database and no HTTP. The containment lives entirely in this file — if the
// hook cannot throw, the handler that calls it cannot 500 because of it — so a
// stub that throws on demand pins the whole behaviour.

const ORG = "Acme Pharma MedComms";

function moduleThat(over: Partial<ProModule>): ProModule {
  return {
    version: "test",
    init: () => {},
    routes: () => {
      throw new Error("routes() is not exercised by these tests");
    },
    status: (): ProStatus => ({
      version: "test",
      is_master: false,
      is_paired: true,
      node_count: 1,
    }),
    pulledOrgByPmid: () => new Map<string, string>(),
    orgCheck: async (): Promise<Map<string, OrgHolding>> => new Map(),
    ...over,
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  registerPro(null);
  warn.mockRestore();
});

describe("pulledOrgByPmid", () => {
  it("passes the module's answer through", () => {
    registerPro(moduleThat({ pulledOrgByPmid: (p) => new Map(p.map((x) => [x, ORG])) }));
    expect(pulledOrgByPmid(["111"]).get("111")).toBe(ORG);
  });

  it("is empty in a free build", () => {
    expect(pulledOrgByPmid(["111"]).size).toBe(0);
  });

  it("never consults the module for an empty page", () => {
    let called = false;
    registerPro(
      moduleThat({
        pulledOrgByPmid: () => {
          called = true;
          return new Map();
        },
      })
    );
    expect(pulledOrgByPmid([]).size).toBe(0);
    expect(called).toBe(false);
  });

  // The failure this exists for: Pro's provenance query dies at request time
  // and takes the entire papers list — every source, free rows included — with
  // it. A badge is not worth a 500 on the view the whole app is built from.
  it("degrades to the free-tier answer when the module throws", () => {
    registerPro(
      moduleThat({
        pulledOrgByPmid: () => {
          throw new Error("no such table: pro_pulled");
        },
      })
    );
    let got: Map<string, string> | undefined;
    expect(() => (got = pulledOrgByPmid(["111", "222"]))).not.toThrow();
    expect(got?.size).toBe(0);
  });

  it("says so in the log rather than failing silently", () => {
    registerPro(
      moduleThat({
        pulledOrgByPmid: () => {
          throw new Error("no such table: pro_pulled");
        },
      })
    );
    pulledOrgByPmid(["111"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("no such table: pro_pulled");
  });

  it("survives a module that throws something that isn't an Error", () => {
    registerPro(
      moduleThat({
        pulledOrgByPmid: () => {
          throw "database is locked";
        },
      })
    );
    expect(pulledOrgByPmid(["111"]).size).toBe(0);
    expect(String(warn.mock.calls[0][0])).toContain("database is locked");
  });
});

describe("proStatus", () => {
  // Deliberately *not* contained, and this pins that on purpose so a later
  // sweep for "unwrapped seam calls" doesn't tidy it into a bug. The only
  // free-tier answer available here is `null`, and null on this hook does not
  // mean "the badge is missing" — it means "this is a free build". Returning it
  // after a failure tells a paying owner their Pro tier vanished, which is the
  // silent downgrade loadPro's comment refuses: it looks like the product
  // working rather than like a bug, and reaches support as "sync stopped" with
  // nothing in the log. A 500 on /auth is loud, and loud is correct here.
  it("lets a failure surface instead of reporting a free build", () => {
    registerPro(
      moduleThat({
        status: () => {
          throw new Error("pro schema missing");
        },
      })
    );
    expect(() => proStatus()).toThrow("pro schema missing");
  });

  it("is null in a free build", () => {
    expect(proStatus()).toBe(null);
  });
});
