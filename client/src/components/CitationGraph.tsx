import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { FileText, ExternalLink, X } from "lucide-react";
import { api } from "../api";
import { useCachedFetch, useDebounced, usePrefersDark, type FetchCache } from "../lib/hooks";
import { openTitle, usePaperOpener, type PaperAccess } from "../lib/openPaper";
import type { Bookmarking } from "../lib/bookmarking";
import { bounds, inYearRange, sourceKey, type PaperFilterState } from "../lib/papers";
import type { GraphNode, GraphResponse, PaperSource } from "../types";
import { clusterByTitle, clusterGraph, NEUTRAL_COLOR, type ClusteringResult } from "../lib/clustering";
import {
  buildAdjacency,
  depthAlpha,
  linkKey,
  walkPaths,
  type PathClosure,
  type PathHit,
} from "../lib/paths";
import { Banner } from "./Banner";
import { BookmarkMenu } from "./BookmarkMenu";
import { PaperFilters } from "./PaperFilters";
import { SaveAllButton } from "./SaveAllButton";

// How cluster colors are derived: by citation links (the collection's citation
// structure) or by title similarity (what papers are about, so related-but-
// uncited work groups together). See clusterByTitle for the v2 abstract upgrade.
type GroupBy = "citation" | "content";

// react-force-graph mutates node/link objects in place (positions on nodes,
// resolved refs on links), so allow extras.
type FGNode = GraphNode & Record<string, unknown>;
interface FGLink {
  source: string | FGNode;
  target: string | FGNode;
}

// force-graph draws each node with radius = sqrt(nodeVal) * nodeRelSize. With
// nodeRelSize=1, feeding val = r² makes the radius exactly r. We want radius to
// scale with log(citations) so landmark papers (10k+ cites) don't dwarf the rest,
// while 0-cite papers stay visible.
function nodeValFromCount(count: number): number {
  const r = 2.5 + 1.3 * Math.log2((count || 0) + 1);
  return r * r;
}

const DIM_ALPHA = 0.1; // everything outside the anchor paper's reach
// How long the pointer must settle on a paper before its paths light up. Without
// it, sweeping the pointer across a dense graph clips dozens of nodes in a
// second and the whole canvas strobes between lit and dimmed. Waiting for intent
// means transited nodes never trigger at all, and moving between two nodes holds
// the previous highlight through the gap instead of flashing back to full color.
const HOVER_SETTLE_MS = 140;

// Canvas accepts #rrggbbaa; cluster colors past the curated palette are hsl(),
// which becomes hsla(). Node colors are re-resolved on every frame, so the
// variants are memoized rather than rebuilt per node per frame. The key space is
// bounded (≤100 cluster colors × a handful of quantized alphas).
const fadeCache = new Map<string, string>();
function fade(color: string, alpha: number): string {
  const key = `${color}|${alpha}`;
  const hit = fadeCache.get(key);
  if (hit) return hit;
  const out = color.startsWith("hsl(")
    ? `hsla(${color.slice(4, -1)}, ${alpha})`
    : color.startsWith("#") && color.length === 7
      ? color + Math.round(alpha * 255).toString(16).padStart(2, "0")
      : color;
  fadeCache.set(key, out);
  return out;
}

// Controls that already mean something by Escape: clearing the search box,
// reverting a number field, closing the journal menu (Radix handles that one on
// the document and lets the event through to the window). The focus-exit
// listener has to sit on the window to catch an Escape aimed at the canvas,
// which has nothing focusable in it — so it filters by origin instead.
const ESCAPE_OWNERS =
  "input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']";


// Cache the last successful graph fetch per source. Remounting the graph — e.g.
// flipping the view toggle back to Graph — then paints from cache instead of
// refetching and re-showing the "Loading citation data…" state. reloadToken is
// bumped when this source's data actually changes ("Check for new papers",
// collection imports and file edits), which invalidates the entry — a change to
// some other source leaves it alone. Only the raw server response is
// cached; the settled node positions still recompute on remount (the layout
// re-runs from scratch).
const graphCache: FetchCache<GraphResponse> = new Map();

export function CitationGraph({
  source,
  reloadToken,
  isAdmin,
  tokenRequired,
  libraryOpen,
  onAuthRefreshed,
  filters,
  bookmarking,
}: PaperAccess & {
  source: PaperSource;
  reloadToken: number;
  filters: PaperFilterState;
  bookmarking: Bookmarking | null;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The citation threshold is shared with the other views (instant: slider +
  // box); hide-unconnected is about edges, so it stays graph-local.
  const { minCitations } = filters;
  const [hideUnconnected, setHideUnconnected] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>("citation");
  const [hiddenClusters, setHiddenClusters] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  // pmid of the paper whose citation paths are pinned on screen, if any.
  const [focus, setFocus] = useState<string | null>(null);
  // Custom tooltip for cluster names (native title has an un-tunable delay).
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const dark = usePrefersDark();
  const { openPaper, opensStoredPdf, openError, clearOpenError } = usePaperOpener({
    isAdmin,
    tokenRequired,
    libraryOpen,
    onAuthRefreshed,
  });

  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 800, height: 600 });

  // Stable fetch key: the same source object is re-created each render. The
  // search is part of it — it selects a different set of papers server-side.
  const key = sourceKey(source);
  const { search, deselected, yearFrom, yearTo } = filters;
  const {
    data: fetched,
    loading,
    error,
  } = useCachedFetch(graphCache, `${key}:${search}`, reloadToken, () =>
    api.getGraph(source, search || undefined)
  );

  // Keep the last result for THIS source on screen while a search refetch is in
  // flight, so typing narrows the graph in place instead of blanking the canvas
  // to the loading message on every keystroke (the papers list does the same).
  const lastForSource = useRef<{ key: string; data: GraphResponse } | null>(null);
  if (fetched) lastForSource.current = { key, data: fetched };
  const data = fetched ?? (lastForSource.current?.key === key ? lastForSource.current.data : null);
  // Only a load with nothing to show counts as loading; a search refetch keeps
  // the previous graph on screen, so it must not fall back to the empty state.
  const showLoading = loading && data == null;

  // Close the paper modal — and drop any highlight or pinned paths — when the
  // graph underneath them changes.
  useEffect(() => {
    setSelected(null);
    setHovered(null);
    setFocus(null);
  }, [key, search, reloadToken]);

  // Keep the canvas sized to its container.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Debounce the threshold that drives the graph + clustering, so dragging the
  // slider doesn't re-run Louvain on every tick (the box itself stays instant).
  const activeMin = useDebounced(minCitations, 250);

  // Stable node objects keyed by pmid. force-graph stores each node's x/y on the
  // object, so we reuse the same objects (never clone) across re-renders.
  const allNodes = useMemo(() => {
    const m = new Map<string, FGNode>();
    if (data) for (const n of data.nodes) m.set(n.pmid, { ...n });
    return m;
  }, [data]);

  // iCite reference lists sometimes carry the paper's own pmid — 4% of papers in
  // a real collection here. A paper cannot cite itself, and the edge is invisible
  // on the canvas either way (force-graph only draws a loop when linkCurvature is
  // set, which it isn't), so it can only ever surface as a wrong answer: it
  // inflates the link readout, and it makes "hide unconnected" count a paper as
  // connected to itself, leaving a lone dot in the one view meant to exclude it.
  // Dropped once, here, rather than at each of the places that read edges.
  const edges = useMemo(() => (data?.edges ?? []).filter((e) => e.source !== e.target), [data]);

  // The set of nodes/links the *simulation* lays out. Only changes with the data
  // or the "hide unconnected" choice — never with the slider — so filtering and
  // clustering never restart (jolt) the layout.
  const graphData = useMemo(() => {
    if (!data) return { nodes: [] as FGNode[], links: [] as FGLink[] };
    const links: FGLink[] = edges.map((e) => ({ source: e.source, target: e.target }));
    let pmids = data.nodes.map((n) => n.pmid);
    if (hideUnconnected) {
      const connected = new Set<string>();
      for (const e of edges) {
        connected.add(e.source);
        connected.add(e.target);
      }
      pmids = pmids.filter((p) => connected.has(p));
    }
    const nodes = pmids.map((p) => allNodes.get(p)).filter(Boolean) as FGNode[];
    return { nodes, links };
  }, [data, edges, allNodes, hideUnconnected]);

  // Both directions of the citation graph, keyed by pmid, for the hover walk.
  // Built once per fetch.
  const adjacency = useMemo(() => buildAdjacency(edges), [edges]);

  // Community detection on the *active* subgraph (papers passing the threshold
  // and the journal filter). Recomputes when the data, the debounced threshold,
  // the journal selection, or the grouping mode changes. Filtering here rather
  // than in graphData keeps it out of the simulation set, so narrowing never
  // restarts the layout. "citation" groups by who cites whom (uses the edges);
  // "content" groups by title similarity (ignores the edges).
  const clustering = useMemo<ClusteringResult>(() => {
    if (!data) return { byPmid: new Map(), clusters: [] };
    const active = graphData.nodes.filter(
      (n) =>
        (n.citationCount as number) >= activeMin &&
        !deselected.has(String(n.journal_name ?? "")) &&
        inYearRange((n.year as number | null) ?? null, yearFrom, yearTo)
    );
    const inputs = active.map((n) => ({
      pmid: n.pmid,
      title: String(n.title ?? ""),
      citationCount: n.citationCount as number,
    }));
    return groupBy === "content" ? clusterByTitle(inputs) : clusterGraph(inputs, edges);
  }, [data, edges, graphData, activeMin, deselected, yearFrom, yearTo, groupBy]);

  // Cluster ids/membership change on each recompute, so old visibility toggles no
  // longer map — reset them whenever the clustering changes.
  useEffect(() => {
    setHiddenClusters(new Set());
  }, [clustering]);

  const maxCitations = useMemo(
    () => (data ? data.nodes.reduce((m, n) => Math.max(m, n.citationCount), 0) : 0),
    [data]
  );

  // The year control's span, from the same node set the citation range uses.
  const yearBounds = useMemo(() => bounds((data?.nodes ?? []).map((n) => n.year)), [data]);

  // Visibility comes in two layers, and they have to stay separate: the path
  // walk is gated on the cluster layer alone, because gating it on the final
  // answer — which includes the focused closure — would be circular.
  const inVisibleCluster = useCallback(
    (pmid: string): boolean => {
      const a = clustering.byPmid.get(pmid);
      return !!a && !hiddenClusters.has(a.community);
    },
    [clustering, hiddenClusters]
  );

  // "Show citation paths" pins one paper and drops everything off its paths.
  // Null whenever the anchor is gone — filtered out, or its cluster hidden — so
  // narrowing past the anchor restores the full graph instead of emptying it.
  const focusPaths = useMemo(
    () => (focus ? walkPaths(focus, adjacency, inVisibleCluster) : null),
    [focus, adjacency, inVisibleCluster]
  );

  const isVisible = useCallback(
    (pmid: string): boolean =>
      inVisibleCluster(pmid) && (!focusPaths || focusPaths.nodes.has(pmid)),
    [inVisibleCluster, focusPaths]
  );

  // Hover walks what's on screen, so inside a focus it explores only the pinned
  // subgraph — hovering a node there shows its own paths within the lineage.
  // Gated on the settled pointer, not the raw one; force-graph's own tooltip
  // still tracks the raw hover, so pointing at a paper stays instantly responsive.
  const settledHover = useDebounced(hovered, HOVER_SETTLE_MS);
  const highlight = useMemo(() => {
    if (!settledHover) return null;
    const found = walkPaths(settledHover, adjacency, isVisible);
    // A closure of just the anchor is nothing to show: dimming the entire canvas
    // to spotlight one dot presents "this paper reaches nothing on screen" as if
    // it were a finding, and the legend can only report it as two zeroes. Both
    // an unconnected paper (with the hide toggle off) and one whose neighbours
    // all fall below the threshold land here. Same floor the modal button
    // applies before it will pin anything.
    return found && found.nodes.size > 1 ? found : null;
  }, [settledHover, adjacency, isVisible]);

  // The papers actually on the canvas: the filter row's set, minus hidden
  // clusters and anything outside a pinned focus. The readout's node count and
  // the bulk-save button's both come from this one list, so the number beside
  // "Save …" is provably the number the readout is reporting — in this view
  // "what's visible" is narrower than what the filters alone select.
  const visiblePmids = useMemo(
    () => [...clustering.byPmid.keys()].filter(isVisible),
    [clustering, isVisible]
  );

  // Counts for the readout (respect threshold, hidden clusters and any focus).
  const shown = useMemo(() => {
    let links = 0;
    for (const e of edges) {
      if (!isVisible(e.source) || !isVisible(e.target)) continue;
      if (focusPaths && !focusPaths.links.has(linkKey(e.source, e.target))) continue;
      links++;
    }
    return { nodes: visiblePmids.length, links };
  }, [visiblePmids, edges, isVisible, focusPaths]);

  // Spread the cluster out so it reads as a network, not a hairball. Re-applied
  // when the simulation set changes (data or hide-unconnected), not on filtering.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || graphData.nodes.length === 0) return;
    const charge = fg.d3Force("charge") as { strength?: (n: number) => void } | undefined;
    charge?.strength?.(-90);
    const link = fg.d3Force("link") as { distance?: (n: number) => void } | undefined;
    link?.distance?.(34);
    fg.d3ReheatSimulation?.();
  }, [graphData]);

  const toggleCluster = (id: number) =>
    setHiddenClusters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Pan/zoom the canvas to frame one cluster's nodes. Deferred a frame so any
  // just-set visibility state has painted before force-graph measures bounds.
  const frameCluster = (id: number) => {
    requestAnimationFrame(() =>
      fgRef.current?.zoomToFit(
        600,
        60,
        (n) => clustering.byPmid.get((n as FGNode).pmid)?.community === id
      )
    );
  };

  const centerCluster = (id: number) => {
    // Make sure it's visible before framing it.
    setHiddenClusters((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    frameCluster(id);
  };

  // From the paper modal: focus just this cluster — close the modal, hide every
  // other cluster, and frame what's left. A one-click "Hide all, then show this
  // one" that also zooms so the surviving cluster isn't left off-screen.
  const isolateCluster = (id: number) => {
    setSelected(null);
    setHiddenClusters(new Set(clustering.clusters.map((c) => c.id).filter((cid) => cid !== id)));
    frameCluster(id);
  };

  const selectedCluster = selected ? clustering.byPmid.get(selected.pmid) : undefined;
  // The open paper's closure, for the modal button's label and enabled state.
  // Walked against the cluster layer, since entering focus replaces any focus
  // already in effect rather than narrowing within it.
  const selectedPaths = useMemo(
    () => (selected ? walkPaths(selected.pmid, adjacency, inVisibleCluster) : null),
    [selected, adjacency, inVisibleCluster]
  );

  // From the paper modal: pin this paper's paths — close the modal, drop every
  // paper that isn't on one, and frame what's left. Hiding doesn't move anything
  // (the simulation still holds every node at the position it settled into), so
  // without the zoom the survivors stay scattered across a canvas sized for the
  // whole collection.
  // Takes the closure the modal button already walked for its label and enabled
  // state rather than repeating the walk on click, so there is one traversal and
  // one copy of the "worth pinning" threshold instead of two to keep in step.
  const showPaths = (pmid: string, paths: PathClosure) => {
    setSelected(null);
    setHovered(null);
    setFocus(pmid);
    requestAnimationFrame(() =>
      fgRef.current?.zoomToFit(600, 60, (n) => paths.nodes.has((n as FGNode).pmid))
    );
  };

  // Leaving focus reframes the whole graph, so the view doesn't stay zoomed into
  // the corner the pinned lineage happened to occupy.
  const clearFocus = useCallback(() => {
    setFocus(null);
    setHovered(null);
    // Frame what is about to be on screen, not the whole simulation: getGraphBbox
    // measures every node its filter admits and ignores nodeVisibility entirely,
    // so an unfiltered fit sizes the canvas for papers that are never drawn and
    // leaves the survivors as a knot in one corner. Gated on inVisibleCluster
    // rather than isVisible because the focus is being dropped — isVisible still
    // has it folded in until this render commits.
    requestAnimationFrame(() =>
      fgRef.current?.zoomToFit(600, 40, (n) => inVisibleCluster((n as FGNode).pmid))
    );
  }, [inVisibleCluster]);

  // Escape exits focus — but not while the modal is open, where Radix owns it.
  // Bound to the pin, not to its closure, so Escape still cancels a pin whose
  // anchor is currently hidden (the banner is showing in that state too).
  useEffect(() => {
    if (!focus || selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest(ESCAPE_OWNERS)) return;
      clearFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, selected, clearFocus]);

  // The neutral (uncolored/singleton) color must flip for dark mode so those
  // nodes don't disappear against the dark canvas. Cluster palette colors are
  // already vivid on both backgrounds.
  const neutralColor = dark ? "#9aa3af" : NEUTRAL_COLOR;
  const clusterColor = (c: string): string => (c === NEUTRAL_COLOR ? neutralColor : c);
  const linkCol = dark ? "rgba(170,176,188,0.3)" : "rgba(110,110,110,0.35)";
  const linkDim = dark ? "rgba(170,176,188,0.07)" : "rgba(110,110,110,0.08)";

  // One hue per direction, plus a high-contrast focus color for the hovered
  // paper itself. They can safely reuse hues from the cluster palette: during a
  // hover every unrelated node is dimmed to DIM_ALPHA, so the only saturated
  // things on the canvas are the paths.
  const citedByColor = dark ? "#fbbf24" : "#d97706"; // amber: papers citing this one
  const citesColor = dark ? "#60a5fa" : "#2563eb"; // blue: papers this one cites
  const focusColor = dark ? "#f8fafc" : "#111827";

  const focusTitle = focus ? String(allNodes.get(focus)?.title ?? "") : "";

  // A hover overrides the pinned closure; the pin is the resting state otherwise.
  // In focus mode the dim branch never fires — everything still on screen is a
  // member — so the same expression covers both.
  const paths = highlight ?? focusPaths;

  const nodeColorFor = (n: FGNode): string => {
    const base = clusterColor(clustering.byPmid.get(n.pmid)?.color ?? NEUTRAL_COLOR);
    if (!paths) return base;
    const hit = paths.nodes.get(n.pmid);
    if (!hit) return fade(base, DIM_ALPHA);
    if (hit.dir === "self") return focusColor;
    // Direction replaces cluster color while paths are showing — which side of
    // the paper a node sits on is the thing being asked about, and the cluster
    // colors come back as soon as the hover or the focus ends.
    return fade(hit.dir === "cites" ? citesColor : citedByColor, depthAlpha(hit.depth));
  };

  const linkHit = (l: FGLink): PathHit | undefined =>
    paths?.links.get(linkKey(endpointId(l.source), endpointId(l.target)));

  return (
    <div className="graph-wrap">
      {/* Full filter row: /api/graph now takes the same `q` as /api/papers and
          returns journal names, so all three views filter identically. */}
      <PaperFilters
        filters={filters}
        journals={data?.journals ?? []}
        maxCitations={maxCitations}
        yearBounds={yearBounds}
        loading={loading}
        action={
          isAdmin &&
          bookmarking && (
            // visiblePmids, not the filter row's set: in this view clusters can
            // be hidden and a focus pinned, and the button must mean the same
            // thing as the "N of M papers" readout it sits beside.
            <SaveAllButton
              pmids={visiblePmids}
              bookmarking={bookmarking}
              onError={setActionError}
              onDone={setNotice}
            />
          )
        }
      >
        <div className="group-by">
          <span>Group by:</span>
          <ToggleGroup.Root
            className="group-toggle"
            type="single"
            value={groupBy}
            // Radix allows deselecting the pressed item (firing ""); keep the
            // current mode rather than leaving the graph with no grouping.
            onValueChange={(v) => v && setGroupBy(v as GroupBy)}
            loop
            aria-label="Cluster grouping"
          >
            <ToggleGroup.Item value="citation">Citations</ToggleGroup.Item>
            <ToggleGroup.Item value="content">Content</ToggleGroup.Item>
          </ToggleGroup.Root>
        </div>
        <label className="graph-check">
          <input
            type="checkbox"
            checked={hideUnconnected}
            onChange={(e) => setHideUnconnected(e.target.checked)}
          />
          Hide unconnected papers
        </label>
        {data && (
          <span className="graph-count">
            {shown.nodes} of {data.nodes.length} papers · {shown.links} citation links
          </span>
        )}
      </PaperFilters>

      {(error ?? actionError ?? openError) && (
        <Banner
          kind="error"
          message={(error ?? actionError ?? openError)!}
          onDismiss={
            actionError || openError
              ? () => {
                  setActionError(null);
                  clearOpenError();
                }
              : undefined
          }
        />
      )}
      {notice && <Banner kind="info" message={notice} onDismiss={() => setNotice(null)} />}

      {/* Names the pinned state, so a sparse canvas is never a mystery, and
          carries the only obvious way out (Escape works too). Keyed on `focus`
          rather than `focusPaths` so it survives the anchor going off screen —
          hiding the anchor's cluster, or filtering past it, leaves the pin set
          but produces no closure, and binding the banner to the closure made the
          pin invisible and uncancellable for as long as that lasted. */}
      {focus && (
        <div className={`path-focus${focusPaths ? "" : " path-focus-dormant"}`}>
          <span className="path-focus-label">Paths through</span>
          <span className="path-focus-title" title={focusTitle}>
            {focusTitle || "(untitled)"}
          </span>
          {focusPaths ? (
            <span className="path-focus-counts">
              <i style={{ backgroundColor: citedByColor }} aria-hidden />
              {focusPaths.citedBy} in citation chain
              <i style={{ backgroundColor: citesColor }} aria-hidden />
              {focusPaths.cites} in reference chain
            </span>
          ) : (
            // No closure to count, and the full graph is on screen. Say why the
            // pin is doing nothing rather than letting it look discarded, since
            // it comes back the moment the anchor does.
            <span className="path-focus-counts">anchor hidden — paths return when it does</span>
          )}
          <button
            type="button"
            className="path-focus-exit"
            onClick={clearFocus}
            aria-label="Show all papers"
            title="Show all papers (Esc)"
          >
            <X size={15} aria-hidden />
          </button>
        </div>
      )}

      <div className="graph-body">
        {/* force-graph updates its pointer position only from its own
            pointermove/pointerdown handlers and registers no leave handler, so
            leaving the canvas from a node — onto the cluster panel, or straight
            off an edge in one flick — leaves its last hover standing and the
            dim and legend up for good. Clear it on the way out. */}
        <div className="graph-canvas" ref={wrapRef} onPointerLeave={() => setHovered(null)}>
          {showLoading ? (
            <div className="empty">Loading citation data… (first load fetches from NIH iCite)</div>
          ) : !data || data.nodes.length === 0 ? (
            <div className="empty">No papers yet.</div>
          ) : (
            <>
              {shown.nodes === 0 && (
                <div className="empty">No papers match the current filters.</div>
              )}
              <ForceGraph2D
                ref={fgRef}
                width={size.width}
                height={size.height}
                graphData={graphData}
                nodeId="pmid"
                nodeLabel={(n) => String((n as FGNode).title ?? "")}
                nodeColor={(n) => nodeColorFor(n as FGNode)}
                nodeRelSize={1}
                // The anchor is one dot among hundreds on its own paths, and a
                // low-cited paper can anchor a large lineage — so enlarge it
                // rather than relying on color alone to find it. val = r², so
                // this is a 1.6x radius.
                nodeVal={(n) => {
                  const val = nodeValFromCount((n as FGNode).citationCount as number);
                  return paths?.nodes.get((n as FGNode).pmid)?.dir === "self" ? val * 2.56 : val;
                }}
                nodeVisibility={(n) => isVisible((n as FGNode).pmid)}
                linkColor={(l) => {
                  if (!paths) return linkCol;
                  const hit = linkHit(l as FGLink);
                  if (!hit) return linkDim;
                  return fade(
                    hit.dir === "cites" ? citesColor : citedByColor,
                    depthAlpha(hit.depth)
                  );
                }}
                // The width and arrow boosts exist to pull a path out of the
                // dimmed graph around it. In focus mode there is no such
                // context — everything left is a path — and thickening all of it
                // just buries the nodes, so only a hover applies them.
                linkWidth={(l) => (highlight && linkHit(l as FGLink) ? 2 : 1)}
                linkVisibility={(l) => {
                  const s = endpointId((l as FGLink).source);
                  const t = endpointId((l as FGLink).target);
                  if (!isVisible(s) || !isVisible(t)) return false;
                  // Two pinned papers can share an edge that isn't itself on a
                  // path through the anchor (one on each side of it). Drop those,
                  // so focus mode shows the path subgraph and nothing else.
                  return !focusPaths || focusPaths.links.has(linkKey(s, t));
                }}
                linkDirectionalArrowLength={(l) => (highlight && linkHit(l as FGLink) ? 6 : 4)}
                linkDirectionalArrowRelPos={1}
                onNodeHover={(n) => setHovered(n ? ((n as FGNode).pmid as string) : null)}
                onNodeClick={(n) => {
                  // The modal covers the canvas, so force-graph never sees the
                  // pointer leave — clear the highlight ourselves.
                  setHovered(null);
                  setSelected(n as unknown as GraphNode);
                }}
                cooldownTicks={120}
                d3VelocityDecay={0.35}
              />
              {/* Names the two hover colors and counts what each reaches. Only
                  present during a hover, so it can't crowd the resting canvas. */}
              {highlight && (
                <div className="graph-legend">
                  <span>
                    <i style={{ backgroundColor: citedByColor }} aria-hidden />
                    {highlight.citedBy} in citation chain
                  </span>
                  <span>
                    <i style={{ backgroundColor: citesColor }} aria-hidden />
                    {highlight.cites} in reference chain
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {data && clustering.clusters.length > 0 && (
          <aside className="cluster-panel">
            <div className="cluster-panel-head">
              <span>Clusters ({clustering.clusters.length})</span>
              {hiddenClusters.size > 0 ? (
                <button className="link-btn" onClick={() => setHiddenClusters(new Set())}>
                  Show all
                </button>
              ) : (
                <button
                  className="link-btn"
                  onClick={() => setHiddenClusters(new Set(clustering.clusters.map((c) => c.id)))}
                >
                  Hide all
                </button>
              )}
            </div>
            <ul className="cluster-list">
              {clustering.clusters.map((c) => (
                <li
                  key={c.id}
                  className={`cluster-row${hiddenClusters.has(c.id) ? " hidden" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="cluster-vis"
                    checked={!hiddenClusters.has(c.id)}
                    onChange={() => toggleCluster(c.id)}
                    aria-label={`Toggle ${c.label}`}
                  />
                  <button
                    type="button"
                    className="cluster-main"
                    onClick={() => centerCluster(c.id)}
                    onMouseEnter={(e) => setTip({ text: c.label, x: e.clientX, y: e.clientY })}
                    onMouseMove={(e) => setTip({ text: c.label, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setTip(null)}
                  >
                    <span className="swatch" style={{ backgroundColor: clusterColor(c.color) }} />
                    <span className="cluster-label">{c.label}</span>
                    <span className="cluster-size">{c.size}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      {selected && (
        <Dialog.Root open onOpenChange={(o) => !o && setSelected(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="modal-backdrop">
              <Dialog.Content className="modal" aria-describedby={undefined}>
                <Dialog.Close className="modal-close" aria-label="Close">
                  <X size={20} aria-hidden />
                </Dialog.Close>
                <div className="modal-head">
                  {/* Marks a node whose title opens the stored PDF rather than
                      PubMed — the click target is otherwise identical. */}
                  {opensStoredPdf(selected) && (
                    <span
                      className="modal-file-icon"
                      aria-label="Opens the stored PDF"
                      title={`Opens ${selected.file_name}`}
                    >
                      <FileText size={15} aria-hidden />
                    </span>
                  )}
                  <p className="modal-meta">
                    {/* Spelled out on hover because the chain counts below sit
                        inches away and measure something else entirely. */}
                    <span title="Direct citations across all of PubMed (NIH iCite), not only papers in this collection">
                      {selected.citationCount} citation{selected.citationCount === 1 ? "" : "s"}
                    </span>
                    {selected.year != null && ` · ${selected.year}`}
                  </p>
                </div>
                <Dialog.Title asChild>
                  <button
                    className="modal-title"
                    onClick={() => openPaper(selected)}
                    title={openTitle(selected, opensStoredPdf)}
                  >
                    {selected.title || "(untitled)"}
                  </button>
                </Dialog.Title>
                {selected.file_id != null && !selected.file_exists && (
                  <p className="modal-file-name">
                    <span className="file-missing" title="The stored PDF is missing">
                      file missing
                    </span>
                  </p>
                )}
                {selectedCluster && (
                  <button
                    type="button"
                    className="modal-cluster"
                    onClick={() => isolateCluster(selectedCluster.community)}
                    title="Show only this cluster"
                  >
                    <span className="swatch" style={{ backgroundColor: clusterColor(selectedCluster.color) }} />
                    <span className="cluster-label">{selectedCluster.label}</span>
                  </button>
                )}
                {/* Kept visible but disabled for an unconnected paper: the label
                    explains the absence, where a missing button would just look
                    inconsistent between papers. */}
                <button
                  type="button"
                  className="modal-paths"
                  onClick={() => selectedPaths && showPaths(selected.pmid, selectedPaths)}
                  disabled={!selectedPaths || selectedPaths.nodes.size <= 1}
                  title={
                    selectedPaths && selectedPaths.nodes.size > 1
                      ? `Show only the ${selectedPaths.nodes.size} papers in this collection on a citation path through this one: ${selectedPaths.citedBy} in its citation chain, ${selectedPaths.cites} in its reference chain`
                      : undefined
                  }
                >
                  {/* Deliberately a paper count, not a citation count: the
                      figure above is iCite's global tally of direct citations,
                      and these chains are transitive but collection-only, so
                      showing them in the same shape would invite comparison
                      between numbers that aren't comparable. */}
                  {selectedPaths && selectedPaths.nodes.size > 1
                    ? `Show citation paths (${selectedPaths.nodes.size} papers)`
                    : "No citation paths"}
                </button>
                {/* The title can now lead to the PDF, so PubMed gets its own
                    link rather than being the only thing the modal opens. The
                    dialog is the graph's only per-paper surface — nodes are
                    canvas-drawn dots with nowhere to hang an icon — so it's
                    also where saving lives. */}
                <p className="modal-links">
                  <a href={selected.url} target="_blank" rel="noreferrer">
                    PubMed <ExternalLink size={13} className="inline-icon" aria-hidden />
                  </a>
                  {isAdmin && bookmarking && (
                    <BookmarkMenu
                      pmid={selected.pmid}
                      bookmarking={bookmarking}
                      onError={setActionError}
                    />
                  )}
                </p>
              </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        </Dialog.Root>
      )}

      {tip && (
        <div
          className="hover-tip"
          style={{ left: Math.min(tip.x + 12, window.innerWidth - 292), top: tip.y + 14 }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}

// A link endpoint is a pmid string before the simulation resolves it, then the
// node object afterwards.
function endpointId(ep: string | FGNode): string {
  return typeof ep === "object" ? ep.pmid : String(ep);
}
