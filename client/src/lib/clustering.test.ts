import { describe, it, expect } from "vitest";
import { clusterGraph, NEUTRAL_COLOR, type ClusterNodeInput, type EdgeInput } from "./clustering";

// Two clean components plus one isolated node. With no inter-component edges,
// Louvain must recover exactly the components, so assertions stay stable.
const nodes: ClusterNodeInput[] = [
  { pmid: "a1", title: "zebrafish cardiac regeneration mechanisms", citationCount: 12 },
  { pmid: "a2", title: "zebrafish heart regeneration signaling", citationCount: 5 },
  { pmid: "a3", title: "cardiac regeneration in adult zebrafish", citationCount: 3 },
  { pmid: "b1", title: "quantum sensing with diamond magnetometry", citationCount: 8 },
  { pmid: "b2", title: "quantum magnetometry sensing advances", citationCount: 2 },
  { pmid: "c1", title: "an unrelated survey of glassblowing", citationCount: 0 },
];

const edges: EdgeInput[] = [
  { source: "a1", target: "a2" },
  { source: "a2", target: "a3" },
  { source: "a1", target: "a3" },
  { source: "b1", target: "b2" },
  // Both ignored: self-loop, and an endpoint outside the node set.
  { source: "c1", target: "c1" },
  { source: "a1", target: "missing" },
];

describe("clusterGraph", () => {
  it("returns an empty result for an empty graph", () => {
    const result = clusterGraph([], []);
    expect(result.clusters).toEqual([]);
    expect(result.byPmid.size).toBe(0);
  });

  it("recovers the connected components as clusters", () => {
    const { byPmid } = clusterGraph(nodes, edges);
    const community = (pmid: string) => byPmid.get(pmid)!.community;

    expect(community("a1")).toBe(community("a2"));
    expect(community("a2")).toBe(community("a3"));
    expect(community("b1")).toBe(community("b2"));
    expect(community("a1")).not.toBe(community("b1"));
  });

  it("pins Singletons first, then ranks real clusters by size from the curated palette", () => {
    const { clusters } = clusterGraph(nodes, edges);
    // The pin is what puts the size-1 bucket ahead of the size-3 and size-2
    // clusters — this fixture is the case that tells the two rules apart, since
    // ranking by size would have put the smallest bucket last instead.
    expect(clusters.map((c) => c.size)).toEqual([1, 3, 2]);
    // Palette order follows size among the real clusters, unaffected by the pin.
    expect(clusters[1].color).toBe("#4e79a7");
    expect(clusters[2].color).toBe("#f28e2b");
  });

  it("adds no Singletons entry when every paper has a link", () => {
    // Same two components, minus the isolated paper: the bucket is built only
    // when something lands in it, so nothing should be pinned ahead here.
    const linked = nodes.filter((n) => n.pmid !== "c1");
    const { clusters } = clusterGraph(linked, edges);

    expect(clusters.map((c) => c.label)).not.toContain("Singletons");
    expect(clusters.map((c) => c.size)).toEqual([3, 2]);
  });

  it("buckets isolated nodes into a neutral Singletons entry pinned first", () => {
    const { byPmid, clusters } = clusterGraph(nodes, edges);
    const singletons = clusters[0];

    expect(singletons.label).toBe("Singletons");
    expect(singletons.size).toBe(1);
    expect(singletons.color).toBe(NEUTRAL_COLOR);
    expect(byPmid.get("c1")).toEqual({
      community: singletons.id,
      color: NEUTRAL_COLOR,
      label: "Singletons",
    });
  });

  it("labels clusters with their distinctive title terms", () => {
    const { byPmid } = clusterGraph(nodes, edges);
    expect(byPmid.get("a1")!.label).toContain("zebrafish");
    expect(byPmid.get("b1")!.label).toContain("quantum");
  });

  it("is deterministic across runs (seeded RNG)", () => {
    const first = clusterGraph(nodes, edges);
    const second = clusterGraph(nodes, edges);
    expect(Object.fromEntries(second.byPmid)).toEqual(Object.fromEntries(first.byPmid));
    expect(second.clusters).toEqual(first.clusters);
  });
});
