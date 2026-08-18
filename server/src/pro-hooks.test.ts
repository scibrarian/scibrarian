import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgHolding, ProStatus } from "../../shared/pro.js";
import type { PaperProvenance } from "../../shared/types.js";
import { hintProSync, paperProvenance, proStatus, registerPro, type ProModule } from "./pro-hooks.js";

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

const ORG: PaperProvenance = { kind: "org", label: "Acme Pharma MedComms" };
const NODE: PaperProvenance = { kind: "node", label: "Dana" };

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
    pulledOrgByPmid: () => new Map<string, PaperProvenance>(),
    receivedNodeByPmid: () => new Map<string, PaperProvenance>(),
    orgCheck: async (): Promise<Map<string, OrgHolding>> => new Map(),
    syncHint: () => {},
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

describe("paperProvenance", () => {
  it("passes the module's answer through", () => {
    registerPro(moduleThat({ pulledOrgByPmid: (p) => new Map(p.map((x) => [x, ORG])) }));
    expect(paperProvenance(["111"]).get("111")).toEqual([ORG]);
  });

  // The master's half, which reaches the caller by a different hook. Worth its
  // own case because every other test here drives the spoke side, so a merge
  // that dropped the contributed answer entirely would still pass them all.
  it("answers from the master side on an instance with no organisation", () => {
    registerPro(moduleThat({ receivedNodeByPmid: () => new Map([["111", NODE]]) }));
    expect(paperProvenance(["111"]).get("111")).toEqual([NODE]);
  });

  it("keeps both answers when one paper arrived by both routes", () => {
    // A hybrid instance: an agency that is a master to its freelancers and a
    // spoke of its client's master. Dana pushed 111 up; the same PMID was later
    // pulled down from the client's library. Neither fact corrects the other —
    // the agency did not buy it either way — and an earlier version merged the
    // two maps by key, silently keeping whichever was spread last and dropping
    // the record that a writer had covered it.
    registerPro(
      moduleThat({
        pulledOrgByPmid: () => new Map([["111", ORG]]),
        receivedNodeByPmid: () => new Map([["111", NODE]]),
      })
    );
    expect(paperProvenance(["111"]).get("111")).toEqual([ORG, NODE]);
  });

  // The failure the per-source containment exists for. These two hooks answer
  // independent questions from independent tables, and they used to share a
  // try — with both calls evaluated as arguments to one expression, so whichever
  // ran first could take the other down before it was ever called.
  it("keeps the org answer when the contributed lookup throws", () => {
    registerPro(
      moduleThat({
        pulledOrgByPmid: () => new Map([["111", ORG]]),
        receivedNodeByPmid: () => {
          throw new Error("no such table: received_files");
        },
      })
    );
    expect(paperProvenance(["111"]).get("111")).toEqual([ORG]);
  });

  it("keeps the contributed answer when the org lookup throws", () => {
    registerPro(
      moduleThat({
        pulledOrgByPmid: () => {
          throw new Error("no such table: pulled_files");
        },
        receivedNodeByPmid: () => new Map([["111", NODE]]),
      })
    );
    expect(paperProvenance(["111"]).get("111")).toEqual([NODE]);
  });

  // A Pro image older than the interface it is being called through. The type
  // describes the contract, not the artefact on disk, and pro/ ships as its own
  // package on its own version.
  it("answers from whatever half a module older than the interface still has", () => {
    const older = moduleThat({ pulledOrgByPmid: () => new Map([["111", ORG]]) });
    delete (older as Partial<ProModule>).receivedNodeByPmid;
    registerPro(older);

    expect(paperProvenance(["111"]).get("111")).toEqual([ORG]);
    expect(warn).toHaveBeenCalledOnce();
  });

  // The skew no try/catch can see: the call *succeeds* and answers in the shape
  // this interface used before provenance was discriminated. Forwarding those
  // strings would put blank badges on a paying customer's rows — the failure
  // mode that matters most on a feature about licensing accuracy.
  it("rejects an answer in the pre-discriminated shape instead of forwarding it", () => {
    registerPro(
      moduleThat({
        pulledOrgByPmid: (() =>
          new Map([["111", "Acme Pharma MedComms"]])) as unknown as ProModule["pulledOrgByPmid"],
        receivedNodeByPmid: () => new Map([["111", NODE]]),
      })
    );
    // The readable half still answers; only the unreadable source is dropped.
    expect(paperProvenance(["111"]).get("111")).toEqual([NODE]);
  });

  it("discards a source's whole answer when any one entry is unreadable", () => {
    // All-or-nothing per source: a hook whose idea of the contract differs from
    // ours has said so, and the entries that happened to parse are no more
    // credible than the one that didn't. Half a licensing answer reads as a
    // complete one.
    registerPro(
      moduleThat({
        pulledOrgByPmid: (() =>
          new Map<string, unknown>([
            ["111", ORG],
            ["222", { kind: "sideways" }],
          ])) as unknown as ProModule["pulledOrgByPmid"],
      })
    );
    expect(paperProvenance(["111", "222"]).size).toBe(0);
  });

  it("is empty in a free build", () => {
    expect(paperProvenance(["111"]).size).toBe(0);
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
    expect(paperProvenance([]).size).toBe(0);
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
    let got: Map<string, PaperProvenance[]> | undefined;
    expect(() => (got = paperProvenance(["111", "222"]))).not.toThrow();
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
    paperProvenance(["111"]);
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
    expect(paperProvenance(["111"]).size).toBe(0);
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

// The one hook called from the *tail* of work the user asked for, rather than
// from a response being assembled. An import that has already matched its files
// and written its rows is finished; the hint only decides how soon a sweep
// notices. So the containment rule here is the strictest in the file — nothing
// this hook does may reach the caller — and these cases are what say so.
describe("hintProSync", () => {
  it("passes the reason through to the module", () => {
    const reasons: string[] = [];
    registerPro(moduleThat({ syncHint: (r) => reasons.push(r) }));
    hintProSync("import finished");
    expect(reasons).toEqual(["import finished"]);
  });

  it("does nothing in a free build", () => {
    expect(() => hintProSync("import finished")).not.toThrow();
  });

  // A Pro image older than this interface is a real deployment. It still sweeps
  // on its own interval, so the feature degrades to exactly what it was before
  // the hook existed rather than to a broken import.
  it("survives a module older than the hook", () => {
    const older = moduleThat({});
    delete (older as Partial<ProModule>).syncHint;
    registerPro(older);

    expect(() => hintProSync("import finished")).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("contains a throw rather than failing the import that called it", () => {
    registerPro(
      moduleThat({
        syncHint: () => {
          throw new Error("database is locked");
        },
      })
    );
    expect(() => hintProSync("import finished")).not.toThrow();
    expect(String(warn.mock.calls[0][0])).toContain("database is locked");
  });
});
