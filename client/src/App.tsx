import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Collection, Disease } from "./types";
import { TabBar } from "./components/TabBar";
import { Timeline } from "./components/Timeline";
import { CitationGraph } from "./components/CitationGraph";
import { CollectionView } from "./components/CollectionView";
import { Settings } from "./components/Settings";

type ViewMode = "timeline" | "graph";

// The selected tab: a disease, a collection, or the settings pane.
export type ActiveTab = { kind: "disease" | "collection"; id: number } | "settings";

export default function App() {
  const [diseases, setDiseases] = useState<Disease[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [active, setActive] = useState<ActiveTab>("settings");
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  function loadDiseases(): Promise<Disease[]> {
    return api
      .getDiseases()
      .then((ds) => {
        setDiseases(ds);
        return ds;
      })
      .catch(() => []);
  }

  function loadCollections(): Promise<Collection[]> {
    return api
      .getCollections()
      .then((cs) => {
        setCollections(cs);
        return cs;
      })
      .catch(() => []);
  }

  useEffect(() => {
    Promise.all([loadDiseases(), loadCollections()]).then(([ds, cs]) => {
      if (ds.length > 0) setActive({ kind: "disease", id: ds[0].id });
      else if (cs.length > 0) setActive({ kind: "collection", id: cs[0].id });
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isDisease = active !== "settings" && active.kind === "disease";
  const isCollection = active !== "settings" && active.kind === "collection";

  const activeDisease = useMemo(
    () => (isDisease ? diseases.find((d) => d.id === (active as { id: number }).id) ?? null : null),
    [active, diseases, isDisease]
  );
  const activeCollection = useMemo(
    () =>
      isCollection
        ? collections.find((c) => c.id === (active as { id: number }).id) ?? null
        : null,
    [active, collections, isCollection]
  );

  async function handleRefresh() {
    setRefreshing(true);
    setStatus(null);
    try {
      const diseaseId = isDisease ? (active as { id: number }).id : undefined;
      const res = await api.refresh(diseaseId);
      const added = res.results.reduce((s, r) => s + r.added, 0);
      const errs = res.results.filter((r) => r.error);
      let msg = `Added ${added} new paper${added === 1 ? "" : "s"}.`;
      if (errs.length) msg += ` ${errs.length} error(s): ${errs.map((e) => e.error).join("; ")}`;
      setStatus(msg);
      await loadDiseases();
      setReloadToken((t) => t + 1);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCreateCollection() {
    const name = window.prompt("Name this collection:");
    if (!name || !name.trim()) return;
    try {
      const created = await api.createCollection(name.trim());
      await loadCollections();
      setActive({ kind: "collection", id: created.id });
      setViewMode("timeline");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  // Label the view toggle per tab kind: collections show "Papers", diseases
  // show "Timeline"; both reuse the "timeline" mode slot for their list view.
  const primaryLabel = isCollection ? "Papers" : "Timeline";

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">🧬</span>
          <h1>SciLuminate</h1>
        </div>
        <div className="header-actions">
          {active !== "settings" && (
            <div className="view-toggle" role="group" aria-label="View mode">
              <button
                className={viewMode === "timeline" ? "active" : ""}
                onClick={() => setViewMode("timeline")}
              >
                {primaryLabel}
              </button>
              <button
                className={viewMode === "graph" ? "active" : ""}
                onClick={() => setViewMode("graph")}
              >
                Graph
              </button>
            </div>
          )}
          {isDisease && activeDisease?.last_polled_at && (
            <span className="updated">Updated {timeAgo(activeDisease.last_polled_at)}</span>
          )}
          {/* Refresh polls PubMed for diseases; collections are user-imported. */}
          {isDisease && (
            <button className="refresh-btn" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh now"}
            </button>
          )}
        </div>
      </header>

      <TabBar
        diseases={diseases}
        collections={collections}
        active={active}
        onSelect={setActive}
        onCreateCollection={handleCreateCollection}
      />

      {status && <div className="banner info">{status}</div>}

      <main className="app-main">
        {!loaded ? (
          <div className="empty">Loading…</div>
        ) : active === "settings" ? (
          <Settings onDataChanged={loadDiseases} />
        ) : isCollection && activeCollection ? (
          viewMode === "graph" ? (
            <CitationGraph source={{ collection: activeCollection.id }} reloadToken={reloadToken} />
          ) : (
            <CollectionView
              key={activeCollection.id}
              collectionId={activeCollection.id}
              onChanged={loadCollections}
              onDeleted={async () => {
                const cs = await loadCollections();
                const ds = diseases;
                if (ds.length > 0) setActive({ kind: "disease", id: ds[0].id });
                else if (cs.length > 0) setActive({ kind: "collection", id: cs[0].id });
                else setActive("settings");
              }}
            />
          )
        ) : activeDisease ? (
          viewMode === "graph" ? (
            <CitationGraph source={{ disease: activeDisease.id }} reloadToken={reloadToken} />
          ) : (
            <Timeline diseaseId={activeDisease.id} reloadToken={reloadToken} />
          )
        ) : (
          <div className="empty">
            No diseases or collections yet. Open <strong>⚙ Settings</strong> to add journals and
            diseases, or click <strong>+ Collection</strong> to import your own papers.
          </div>
        )}
      </main>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
