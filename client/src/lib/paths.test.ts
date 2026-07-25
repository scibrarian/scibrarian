import { describe, it, expect } from "vitest";
import { buildAdjacency, depthAlpha, linkKey, walkPaths, type PathClosure } from "./paths";

const all = () => true;
const edges = (...pairs: string[]) =>
  pairs.map((p) => {
    const [source, target] = p.split(">");
    return { source, target };
  });

// Convenience: the closure is never null in these fixtures, and asserting that
// at every call site would bury what each test is actually about.
const walk = (
  root: string,
  es: { source: string; target: string }[],
  can: (pmid: string) => boolean = all
): PathClosure => {
  const c = walkPaths(root, buildAdjacency(es), can);
  if (!c) throw new Error(`expected a closure for ${root}`);
  return c;
};

const dirs = (c: PathClosure) =>
  Object.fromEntries([...c.nodes].map(([p, h]) => [p, `${h.dir}@${h.depth}`]));

describe("buildAdjacency", () => {
  it("indexes both directions of each edge", () => {
    const { out, inc } = buildAdjacency(edges("a>b", "a>c", "d>b"));
    expect(out.get("a")).toEqual(["b", "c"]);
    expect(inc.get("b")).toEqual(["a", "d"]);
    expect(out.get("b")).toBeUndefined();
  });

  // 108 rows in the live dataset list their own pmid as a reference. A paper
  // citing itself is bad data, not a path, and a self-loop would otherwise show
  // up as a zero-length edge on the canvas.
  it("drops self-citations", () => {
    const { out, inc } = buildAdjacency(edges("a>a", "a>b"));
    expect(out.get("a")).toEqual(["b"]);
    expect(inc.get("a")).toBeUndefined();
  });

  it("handles an empty edge list", () => {
    const { out, inc } = buildAdjacency([]);
    expect(out.size).toBe(0);
    expect(inc.size).toBe(0);
  });
});

describe("depthAlpha", () => {
  it("keeps the anchor and its immediate neighbours at full strength", () => {
    expect(depthAlpha(0)).toBe(1);
    expect(depthAlpha(1)).toBe(1);
  });

  it("fades with distance but never below the floor", () => {
    expect(depthAlpha(2)).toBeCloseTo(0.8);
    expect(depthAlpha(3)).toBeCloseTo(0.64);
    expect(depthAlpha(50)).toBe(0.3);
  });
});

describe("walkPaths", () => {
  it("returns null when the root itself is not visitable", () => {
    expect(walkPaths("a", buildAdjacency(edges("a>b")), () => false)).toBeNull();
  });

  // The anchor is always present, so a paper with no reachable neighbours still
  // yields a closure — of size 1. Callers use that to decide there is nothing
  // worth showing, rather than dimming the whole canvas around a lone dot.
  it("returns a closure of just the anchor for an unconnected paper", () => {
    const c = walk("z", edges("a>b"));
    expect(c.nodes.size).toBe(1);
    expect(c.nodes.get("z")).toEqual({ dir: "self", depth: 0 });
    expect(c.links.size).toBe(0);
    expect(c.cites).toBe(0);
    expect(c.citedBy).toBe(0);
  });

  // b -> a means b cites a, so from a it is part of the CITATION chain; a -> c
  // means a cites c, so c is part of the REFERENCE chain.
  it("separates the two directions and records hop distance", () => {
    const c = walk("a", edges("b>a", "x>b", "a>c", "c>d"));
    expect(dirs(c)).toEqual({
      a: "self@0",
      b: "citedBy@1",
      x: "citedBy@2",
      c: "cites@1",
      d: "cites@2",
    });
    expect(c.citedBy).toBe(2);
    expect(c.cites).toBe(2);
  });

  it("counts every node except the anchor exactly once", () => {
    const c = walk("a", edges("b>a", "x>b", "a>c", "c>d"));
    expect(c.cites + c.citedBy + 1).toBe(c.nodes.size);
  });

  it("stores links source-cites-target whichever way it walked", () => {
    const c = walk("a", edges("b>a", "a>c"));
    expect(c.links.has(linkKey("b", "a"))).toBe(true);
    expect(c.links.has(linkKey("a", "c"))).toBe(true);
    expect(c.links.has(linkKey("a", "b"))).toBe(false);
  });

  it("records the shortest hop distance when a paper is reachable two ways", () => {
    // a -> b -> c and a -> c directly: c is one hop, not two.
    const c = walk("a", edges("a>b", "b>c", "a>c"));
    expect(c.nodes.get("c")).toEqual({ dir: "cites", depth: 1 });
  });

  it("does not route through a paper canVisit rejects", () => {
    // a -> b -> c, with b filtered out: c is unreachable even though it exists.
    const c = walk("a", edges("a>b", "b>c"), (p) => p !== "b");
    expect([...c.nodes.keys()]).toEqual(["a"]);
    expect(c.links.size).toBe(0);
  });

  // --- reciprocal citation ---------------------------------------------------
  // Regression: both walks used to share one `nodes` map as their frontier gate,
  // so whichever ran first (citedBy) could claim a paper the other still needed
  // to expand. Companion papers published back-to-back cite each other, which is
  // normal scholarly practice rather than bad data, and the live dataset has 9
  // such pairs — pinning one of them dropped up to half its lineage.
  describe("papers that cite each other", () => {
    it("still follows the partner's references", () => {
      // a and b cite each other; b also cites z. z is genuinely a -> b -> z.
      const c = walk("a", edges("a>b", "b>a", "b>z"));
      expect(c.nodes.has("z")).toBe(true);
      expect(c.nodes.size).toBe(3);
    });

    it("keeps first-arrival direction for the partner itself", () => {
      // The citedBy walk runs first, so b stays citedBy even though a cites it.
      const c = walk("a", edges("a>b", "b>a", "b>z"));
      expect(c.nodes.get("b")?.dir).toBe("citedBy");
    });

    it("terminates on a longer cycle through the anchor", () => {
      const c = walk("a", edges("a>b", "b>c", "c>a"));
      expect(c.nodes.size).toBe(3);
    });

    it("reaches everything downstream of a mutually-cited chain", () => {
      // a <-> b, b -> c -> d: the whole tail hangs off the reciprocal pair.
      const c = walk("a", edges("a>b", "b>a", "b>c", "c>d"));
      expect([...c.nodes.keys()].sort()).toEqual(["a", "b", "c", "d"]);
    });
  });

  it("is unaffected by a cycle that does not pass through the anchor", () => {
    // b and c cite each other, downstream of a. Both are on the cites walk, so
    // this case was always handled; pinned here so it stays that way.
    const c = walk("a", edges("a>b", "b>c", "c>b", "c>d"));
    expect([...c.nodes.keys()].sort()).toEqual(["a", "b", "c", "d"]);
    expect(c.cites).toBe(3);
  });

  it("explores a wide graph without revisiting nodes", () => {
    // A 200-node chain: proves the frontier is bounded and depth keeps counting.
    const chain = Array.from({ length: 199 }, (_, i) => `p${i}>p${i + 1}`);
    const c = walk("p0", edges(...chain));
    expect(c.nodes.size).toBe(200);
    expect(c.nodes.get("p199")).toEqual({ dir: "cites", depth: 199 });
    expect(c.cites).toBe(199);
  });
});
