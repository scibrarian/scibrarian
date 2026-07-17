import Graph from "graphology";
import louvain from "graphology-communities-louvain";

export interface ClusterNodeInput {
  pmid: string;
  title: string;
  citationCount: number;
}

export interface EdgeInput {
  source: string;
  target: string;
}

export interface ClusterAssignment {
  community: number; // clusterKey; all singletons share SINGLETON_KEY
  color: string;
  label: string;
}

export interface ClusterInfo {
  id: number; // clusterKey
  label: string;
  color: string;
  size: number;
}

export interface ClusteringResult {
  byPmid: Map<string, ClusterAssignment>;
  clusters: ClusterInfo[]; // size-sorted; "Singletons" bucket (if any) last
}

const SINGLETON_KEY = -1;
export const NEUTRAL_COLOR = "#111111";
const TOP_N = 100;

// Curated, maximally-distinct colors for the largest clusters.
const PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#1f9e89",
];

// Color for a cluster's size rank. The first 10 use the curated palette; the
// rest get a golden-angle hue spread (many will look similar past ~20, which is
// expected when coloring up to 100 clusters).
function rankColor(rank: number): string {
  if (rank < PALETTE.length) return PALETTE[rank];
  const hue = (rank * 137.508) % 360;
  const sat = 60 + (rank % 3) * 10; // 60 / 70 / 80
  const light = 45 + (rank % 2) * 9; // 45 / 54
  return `hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`;
}

// Deterministic RNG so the same filtered graph always yields the same partition.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STOPWORDS = new Set(
  (
    "the a an and or of in on for to with without by from as at is are was were be been being " +
    "this that these those it its their our we using use used via vs versus after before during " +
    "between among within into over under not no new novel study studies trial trials randomized " +
    "randomised controlled clinical patient patients human humans result results analysis review " +
    "reviews systematic meta evidence effect effects efficacy outcome outcomes risk treatment " +
    "therapy therapies disease diseases disorder disorders associated association based role " +
    "management care health data model models group groups case cases report reports year years " +
    "age aged high low level levels response responses function functional approach approaches " +
    "compared comparison versus more less may can also among across due per via toward towards"
  ).split(/\s+/)
);

function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
}

// Top distinctive terms for a community using c-TF-IDF on titles: a term scores
// by how often it appears in this cluster weighted by how rare it is overall.
function labelFor(
  pmids: string[],
  titleTokens: Map<string, string[]>,
  globalDf: Map<string, number>,
  totalDocs: number
): string {
  const clusterDf = new Map<string, number>();
  for (const pmid of pmids) {
    const seen = new Set(titleTokens.get(pmid) ?? []);
    for (const term of seen) clusterDf.set(term, (clusterDf.get(term) ?? 0) + 1);
  }
  const scored = [...clusterDf.entries()]
    .map(([term, df]) => {
      const idf = Math.log(totalDocs / (1 + (globalDf.get(term) ?? 0)));
      return { term, score: df * idf };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const top = scored.slice(0, 3).map((s) => s.term);
  return top.length ? top.join(" · ") : "(untitled cluster)";
}

export function clusterGraph(nodes: ClusterNodeInput[], edges: EdgeInput[]): ClusteringResult {
  const result: ClusteringResult = { byPmid: new Map(), clusters: [] };
  if (nodes.length === 0) return result;

  const present = new Set(nodes.map((n) => n.pmid));
  const graph = new Graph({ type: "undirected" });
  for (const n of nodes) graph.addNode(n.pmid);
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (present.has(e.source) && present.has(e.target)) graph.mergeEdge(e.source, e.target);
  }

  const mapping = louvain(graph, { rng: mulberry32(42) }) as Record<string, number>;

  // Group pmids by raw community id.
  const members = new Map<number, string[]>();
  for (const n of nodes) {
    const c = mapping[n.pmid] ?? 0;
    const list = members.get(c);
    if (list) list.push(n.pmid);
    else members.set(c, [n.pmid]);
  }

  // Precompute title tokens + global document frequency for labeling.
  const titleTokens = new Map<string, string[]>();
  const globalDf = new Map<string, number>();
  for (const n of nodes) {
    const tokens = tokenize(n.title || "");
    titleTokens.set(n.pmid, tokens);
    for (const term of new Set(tokens)) globalDf.set(term, (globalDf.get(term) ?? 0) + 1);
  }
  const totalDocs = nodes.length;

  // Real clusters = communities of size >= 2, ranked by size (ties: larger id last
  // -> smaller id first for stability). The largest TOP_N get colors (the first
  // 10 from the curated palette, then golden-angle hues); anything beyond that
  // is neutral black.
  const real = [...members.entries()]
    .filter(([, pmids]) => pmids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);

  real.forEach(([id, pmids], rank) => {
    const color = rank < TOP_N ? rankColor(rank) : NEUTRAL_COLOR;
    const label = labelFor(pmids, titleTokens, globalDf, totalDocs);
    result.clusters.push({ id, label, color, size: pmids.length });
    for (const pmid of pmids) result.byPmid.set(pmid, { community: id, color, label });
  });

  // Bucket every size-1 community into one "Singletons" entry.
  const singletons: string[] = [];
  for (const [, pmids] of members) if (pmids.length === 1) singletons.push(pmids[0]);
  if (singletons.length > 0) {
    const label = "Singletons";
    result.clusters.push({
      id: SINGLETON_KEY,
      label,
      color: NEUTRAL_COLOR,
      size: singletons.length,
    });
    for (const pmid of singletons)
      result.byPmid.set(pmid, { community: SINGLETON_KEY, color: NEUTRAL_COLOR, label });
  }

  return result;
}
