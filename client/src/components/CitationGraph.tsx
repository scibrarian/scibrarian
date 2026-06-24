import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { api } from "../api";
import type { GraphNode, GraphResponse } from "../types";

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

export function CitationGraph({
  diseaseId,
  reloadToken,
}: {
  diseaseId: number;
  reloadToken: number;
}) {
  const [data, setData] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minCitations, setMinCitations] = useState(0);
  const [minText, setMinText] = useState("0"); // controlled string for the number box
  const [hideUnconnected, setHideUnconnected] = useState(true);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(null);
    api
      .getGraph(diseaseId)
      .then((res) => !cancelled && setData(res))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [diseaseId, reloadToken]);

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

  // Stable node objects keyed by pmid. force-graph stores each node's x/y on the
  // object, so we reuse the same objects (never clone) across re-renders.
  const allNodes = useMemo(() => {
    const m = new Map<string, FGNode>();
    if (data) for (const n of data.nodes) m.set(n.pmid, { ...n });
    return m;
  }, [data]);

  // The set of nodes/links the *simulation* lays out. This only changes when the
  // data or the "hide unconnected" structural choice changes — NOT when the
  // min-citations slider moves. The slider is applied via visibility below, which
  // is a pure repaint and never restarts (jolts) the layout.
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

  const maxCitations = useMemo(
    () => (data ? data.nodes.reduce((m, n) => Math.max(m, n.citationCount), 0) : 0),
    [data]
  );

  // Counts for the readout — recomputed cheaply as the slider moves.
  const shown = useMemo(() => {
    const nodes = graphData.nodes.filter((n) => n.citationCount >= minCitations);
    const ids = new Set(nodes.map((n) => n.pmid));
    const links = graphData.links.filter(
      (l) => ids.has(endpointId(l.source)) && ids.has(endpointId(l.target))
    );
    return { nodes: nodes.length, links: links.length };
  }, [graphData, minCitations]);

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

  const citationOf = (ep: string | FGNode): number =>
    typeof ep === "object" ? (ep.citationCount ?? 0) : (allNodes.get(ep)?.citationCount ?? 0);

  // Slider and number input share this range; the number input is clamped so a
  // typed value always maps to a valid slider position.
  const sliderMax = Math.max(10, maxCitations);
  const clampMin = (raw: string): number => {
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return 0;
    return Math.min(Math.max(0, v), sliderMax);
  };
  // Keep slider and text box in lockstep; setting minText to String(v) drops any
  // leading zeros and reflects clamping.
  const setBothMin = (v: number) => {
    setMinCitations(v);
    setMinText(String(v));
  };
  const handleMinText = (raw: string) => {
    const digits = raw.replace(/\D/g, ""); // digits only
    if (digits === "") {
      setMinText(""); // allow an empty field while editing
      setMinCitations(0);
      return;
    }
    setBothMin(clampMin(digits));
  };

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

      <div className="graph-canvas" ref={wrapRef}>
        {loading ? (
          <div className="empty">Loading citation data… (first load fetches from NIH iCite)</div>
        ) : !data || data.nodes.length === 0 ? (
          <div className="empty">No papers yet for this disease.</div>
        ) : (
          <>
            {shown.nodes === 0 && <div className="empty">No papers match the current filters.</div>}
            <ForceGraph2D
              ref={fgRef}
              width={size.width}
              height={size.height}
              graphData={graphData}
              nodeId="pmid"
              nodeLabel={(n) => String((n as FGNode).title ?? "")}
              nodeColor={() => "#2e9e5b"}
              nodeRelSize={1}
              nodeVal={(n) => nodeValFromCount((n as FGNode).citationCount as number)}
              nodeVisibility={(n) => ((n as FGNode).citationCount as number) >= minCitations}
              linkColor={() => "rgba(110,110,110,0.35)"}
              linkVisibility={(l) =>
                citationOf((l as FGLink).source) >= minCitations &&
                citationOf((l as FGLink).target) >= minCitations
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
            </p>
            <a className="modal-title" href={selected.url} target="_blank" rel="noreferrer">
              {selected.title || "(untitled)"}
            </a>
            <p className="hint">Opens on PubMed ↗</p>
          </div>
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
