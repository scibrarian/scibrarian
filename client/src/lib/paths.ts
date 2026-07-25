// Citation path tracing: every path into and out of one paper — the full
// transitive closure, not just its neighbors. Drives two features off the same
// walk — hovering dims whatever isn't on a path, and "Show citation paths" hides
// it outright. The two directions get their own hue, so which way a path runs
// reads without having to resolve the arrowheads, and each hop fades a little
// further so distance from the anchor paper is visible too. "cites" = what this
// paper builds on; "citedBy" = what builds on it.
//
// These counts are surfaced as the "citation chain" and "reference chain", never
// as citations, because they differ from a paper's citationCount on two axes at
// once: they are transitive rather than direct, and confined to this collection
// rather than all of PubMed (citationCount is iCite's global tally, and edges
// exist only where both endpoints are in the dataset). The two effects push in
// opposite directions, so neither number bounds the other — keep the vocabulary
// distinct so they are never read as the same measure.
//
// Kept out of the component because the traversal is the subtle part and the
// component isn't reachable from a node-environment test (see vitest.config.ts).

export type Dir = "self" | "cites" | "citedBy";

export interface PathHit {
  dir: Dir;
  depth: number;
}

export interface PathClosure {
  nodes: Map<string, PathHit>;
  links: Map<string, PathHit>;
  cites: number;
  citedBy: number;
}

// Both directions of the citation graph, keyed by pmid. An edge P -> R means P
// cites R, so `out` reaches what a paper builds on and `inc` reaches what builds
// on it.
export interface Adjacency {
  out: Map<string, string[]>;
  inc: Map<string, string[]>;
}

const HOP_FALLOFF = 0.8; // alpha multiplier per extra hop
const MIN_HOP_ALPHA = 0.3; // floor, so deep lineage stays visible

export function depthAlpha(depth: number): number {
  return depth <= 1 ? 1 : Math.max(MIN_HOP_ALPHA, HOP_FALLOFF ** (depth - 1));
}

export const linkKey = (source: string, target: string): string => `${source}>${target}`;

export function buildAdjacency(edges: readonly { source: string; target: string }[]): Adjacency {
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, from: string, to: string) => {
    const list = m.get(from);
    if (list) list.push(to);
    else m.set(from, [to]);
  };
  for (const e of edges) {
    if (e.source === e.target) continue; // a paper citing itself is bad data, not a path
    add(out, e.source, e.target);
    add(inc, e.target, e.source);
  }
  return { out, inc };
}

// Walk both directions from `root`, recording each node's hop distance and every
// link on a path through it. `canVisit` gates what the walk may cross: a path may
// not route through a paper that isn't on screen, so hidden and filtered-out
// papers stop it. Returns null when the root itself isn't visitable.
export function walkPaths(
  root: string,
  adjacency: Adjacency,
  canVisit: (pmid: string) => boolean
): PathClosure | null {
  if (!canVisit(root)) return null;
  const nodes = new Map<string, PathHit>([[root, { dir: "self", depth: 0 }]]);
  const links = new Map<string, PathHit>();
  const counts = { cites: 0, citedBy: 0 };

  // Breadth-first, so the first arrival at a node carries its true hop distance.
  //
  // Each direction tracks its own frontier admissions rather than sharing
  // `nodes` with the other. Gating on `nodes` conflated two jobs, and the second
  // one was wrong: it let the citedBy walk claim a paper the cites walk still
  // needed to expand, so that paper's own references were never followed and the
  // reference chain silently stopped there. It bites wherever two papers cite
  // each other, which needs no bad data at all — companion papers published
  // back-to-back routinely do, and pinning one of a reciprocal pair was dropping
  // up to half its lineage.
  //
  // `nodes` stays first-arrival-wins, so nothing already found is dropped and no
  // paper changes direction. Depths can only improve: a node the cites walk used
  // to reach the long way round — or not at all — now arrives at its true hop
  // distance, never a worse one, so the depth fade gets more accurate rather than
  // merely different. Links still resolve cites-over-citedBy where both walks
  // reach them, since that one runs second; this only lets it reach the edges it
  // should have had all along. Still bounded and still safe against a cycle,
  // because a node enters each walk's frontier at most once.
  const walk = (dir: "cites" | "citedBy") => {
    const next = dir === "cites" ? adjacency.out : adjacency.inc;
    const seen = new Set([root]);
    let frontier = [root];
    for (let depth = 1; frontier.length > 0; depth++) {
      const level: string[] = [];
      for (const from of frontier) {
        for (const to of next.get(from) ?? []) {
          if (!canVisit(to)) continue;
          // Links are stored source-cites-target, whichever way we walked.
          links.set(dir === "cites" ? linkKey(from, to) : linkKey(to, from), { dir, depth });
          if (seen.has(to)) continue; // this walk has already been through it
          seen.add(to);
          // The other direction may already own it; first arrival keeps it.
          if (!nodes.has(to)) {
            nodes.set(to, { dir, depth });
            counts[dir]++;
          }
          level.push(to);
        }
      }
      frontier = level;
    }
  };
  walk("citedBy");
  walk("cites");
  return { nodes, links, ...counts };
}
