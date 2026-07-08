import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { api } from "../api";
import { useCachedFetch, useDebounced, usePrefersDark, type FetchCache } from "../lib/hooks";
import type { GraphNode, GraphResponse, GraphSource } from "../types";
import { clusterGraph, NEUTRAL_COLOR, type ClusteringResult } from "../lib/clustering";

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

// Cache the last successful graph fetch per source. Remounting the graph — e.g.
// flipping the Timeline/Graph toggle back to Graph — then paints from cache
// instead of refetching and re-showing the "Loading citation data…" state.
// reloadToken is bumped when the data actually changes ("Refresh now"), which
// invalidates the entry. Only the raw server response is cached; the settled
// node positions still recompute on remount (the layout re-runs from scratch).
const keyOf = (source: GraphSource) =>
  "disease" in source ? `d${source.disease}` : `c${source.collection}`;
const graphCache: FetchCache<GraphResponse> = new Map();

export function CitationGraph({
  source,
  reloadToken,
}: {
  source: GraphSource;
  reloadToken: number;
}) {
  const [minCitations, setMinCitations] = useState(0); // instant: slider + box
  const [minText, setMinText] = useState("0"); // controlled string for the number box
  const [hideUnconnected, setHideUnconnected] = useState(true);
  const [hiddenClusters, setHiddenClusters] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<GraphNode | null>(null);
  // Custom tooltip for cluster names (native title has an un-tunable delay).
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const dark = usePrefersDark();

  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 800, height: 600 });

  // Stable fetch key: the same source object is re-created each render.
  const sourceKey = keyOf(source);
  const { data, loading, error } = useCachedFetch(graphCache, sourceKey, reloadToken, () =>
    api.getGraph(source)
  );

  // Close the paper modal when the graph underneath it changes.
  useEffect(() => setSelected(null), [sourceKey, reloadToken]);

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

  // The set of nodes/links the *simulation* lays out. Only changes with the data
  // or the "hide unconnected" choice — never with the slider — so filtering and
  // clustering never restart (jolt) the layout.
  const graphData = useMemo(() => {
    if (!data) return { nodes: [] as FGNode[], links: [] as FGLink[] };
    const links: FGLink[] = data.edges.map((e) => ({ source: e.source, target: e.target }));
    let pmids = data.nodes.map((n) => n.pmid);
    if (hideUnconnected) {
      const connected = new Set<string>();
      for (const e of data.edges) {
        connected.add(e.source);
        connected.add(e.target);
      }
      pmids = pmids.filter((p) => connected.has(p));
    }
    const nodes = pmids.map((p) => allNodes.get(p)).filter(Boolean) as FGNode[];
    return { nodes, links };
  }, [data, allNodes, hideUnconnected]);

  // Community detection on the *active* subgraph (papers passing the threshold).
  // Recomputes when the data or the debounced threshold changes.
  const clustering = useMemo<ClusteringResult>(() => {
    if (!data) return { byPmid: new Map(), clusters: [] };
    const active = graphData.nodes.filter((n) => (n.citationCount as number) >= activeMin);
    return clusterGraph(
      active.map((n) => ({
        pmid: n.pmid,
        title: String(n.title ?? ""),
        citationCount: n.citationCount as number,
      })),
      data.edges
    );
  }, [data, graphData, activeMin]);

  // Cluster ids/membership change on each recompute, so old visibility toggles no
  // longer map — reset them whenever the clustering changes.
  useEffect(() => {
    setHiddenClusters(new Set());
  }, [clustering]);

  const maxCitations = useMemo(
    () => (data ? data.nodes.reduce((m, n) => Math.max(m, n.citationCount), 0) : 0),
    [data]
  );

  const isVisible = (pmid: string): boolean => {
    const a = clustering.byPmid.get(pmid);
    return !!a && !hiddenClusters.has(a.community);
  };

  // Counts for the readout (respect threshold + hidden clusters).
  const shown = useMemo(() => {
    let nodes = 0;
    for (const a of clustering.byPmid.values()) if (!hiddenClusters.has(a.community)) nodes++;
    let links = 0;
    if (data)
      for (const e of data.edges) {
        const s = clustering.byPmid.get(e.source);
        const t = clustering.byPmid.get(e.target);
        if (s && t && !hiddenClusters.has(s.community) && !hiddenClusters.has(t.community)) links++;
      }
    return { nodes, links };
  }, [clustering, hiddenClusters, data]);

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

  const centerCluster = (id: number) => {
    // Make sure it's visible before framing it.
    setHiddenClusters((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    requestAnimationFrame(() =>
      fgRef.current?.zoomToFit(
        600,
        60,
        (n) => clustering.byPmid.get((n as FGNode).pmid)?.community === id
      )
    );
  };

  // Slider and number input share this range; the number input is clamped so a
  // typed value always maps to a valid slider position.
  const sliderMax = Math.max(10, maxCitations);
  const clampMin = (raw: string): number => {
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return 0;
    return Math.min(Math.max(0, v), sliderMax);
  };
  const setBothMin = (v: number) => {
    setMinCitations(v);
    setMinText(String(v));
  };
  const handleMinText = (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (digits === "") {
      setMinText("");
      setMinCitations(0);
      return;
    }
    setBothMin(clampMin(digits));
  };

  const selectedCluster = selected ? clustering.byPmid.get(selected.pmid) : undefined;

  // The neutral (uncolored/singleton) color must flip for dark mode so those
  // nodes don't disappear against the dark canvas. Cluster palette colors are
  // already vivid on both backgrounds.
  const neutralColor = dark ? "#9aa3af" : NEUTRAL_COLOR;
  const clusterColor = (c: string): string => (c === NEUTRAL_COLOR ? neutralColor : c);
  const linkCol = dark ? "rgba(170,176,188,0.3)" : "rgba(110,110,110,0.35)";

  return (
    <div className="graph-wrap">
      <div className="toolbar">
        <div className="graph-filter">
          <span>Min citations:</span>
          <input
            type="text"
            inputMode="numeric"
            className="min-input"
            value={minText}
            onChange={(e) => handleMinText(e.target.value)}
            onBlur={() => minText === "" && setMinText("0")}
          />
          <input
            type="range"
            min={0}
            max={sliderMax}
            value={minCitations}
            onChange={(e) => setBothMin(clampMin(e.target.value))}
          />
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
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="graph-body">
        <div className="graph-canvas" ref={wrapRef}>
          {loading ? (
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
                nodeColor={(n) =>
                  clusterColor(clustering.byPmid.get((n as FGNode).pmid)?.color ?? NEUTRAL_COLOR)
                }
                nodeRelSize={1}
                nodeVal={(n) => nodeValFromCount((n as FGNode).citationCount as number)}
                nodeVisibility={(n) => isVisible((n as FGNode).pmid)}
                linkColor={() => linkCol}
                linkVisibility={(l) =>
                  isVisible(endpointId((l as FGLink).source)) &&
                  isVisible(endpointId((l as FGLink).target))
                }
                linkDirectionalArrowLength={4}
                linkDirectionalArrowRelPos={1}
                onNodeClick={(n) => setSelected(n as unknown as GraphNode)}
                cooldownTicks={120}
                d3VelocityDecay={0.35}
              />
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
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="modal-close"
              onClick={() => setSelected(null)}
              aria-label="Close"
            >
              ×
            </button>
            <p className="modal-meta">
              {selected.citationCount} citation{selected.citationCount === 1 ? "" : "s"}
              {selected.year != null && ` · ${selected.year}`}
            </p>
            <a className="modal-title" href={selected.url} target="_blank" rel="noreferrer">
              {selected.title || "(untitled)"}
            </a>
            {selectedCluster && (
              <p className="modal-cluster">
                <span className="swatch" style={{ backgroundColor: clusterColor(selectedCluster.color) }} />
                {selectedCluster.label}
              </p>
            )}
          </div>
        </div>
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
