import { useEffect, useState } from "react";
import { api } from "./api";
import type { Collection, Disease } from "./types";
import { WorkspaceNav, type Mode } from "./components/WorkspaceNav";
import { Timeline } from "./components/Timeline";
import { CitationGraph } from "./components/CitationGraph";
import { CollectionView } from "./components/CollectionView";
import { Settings } from "./components/Settings";

type ViewMode = "timeline" | "graph";

export default function App() {
  const [diseases, setDiseases] = useState<Disease[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [mode, setMode] = useState<Mode>("discover");
  const [showSettings, setShowSettings] = useState(false);
  const [activeDiseaseId, setActiveDiseaseId] = useState<number | null>(null);
  const [activeCollectionId, setActiveCollectionId] = useState<number | null>(null);
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
      // Land in whichever workspace actually has something in it.
      if (ds.length > 0) {
        setMode("discover");
        setActiveDiseaseId(ds[0].id);
      } else if (cs.length > 0) {
        setMode("papers");
        setActiveCollectionId(cs[0].id);
      }
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeDisease = diseases.find((d) => d.id === activeDiseaseId) ?? null;
  const activeCollection = collections.find((c) => c.id === activeCollectionId) ?? null;

  function changeMode(m: Mode) {
    setShowSettings(false);
    setMode(m);
    if (m === "discover" && activeDiseaseId == null && diseases.length > 0) {
      setActiveDiseaseId(diseases[0].id);
    }
    if (m === "papers" && activeCollectionId == null && collections.length > 0) {
      setActiveCollectionId(collections[0].id);
    }
  }

  function selectDisease(id: number) {
    setShowSettings(false);
    setMode("discover");
    setActiveDiseaseId(id);
  }

  function selectCollection(id: number) {
    setShowSettings(false);
    setMode("papers");
    setActiveCollectionId(id);
  }

  async function handleCreateCollection() {
    const name = window.prompt("Name this collection:");
    if (!name || !name.trim()) return;
    try {
      const created = await api.createCollection(name.trim());
      await loadCollections();
      setShowSettings(false);
      setMode("papers");
      setActiveCollectionId(created.id);
      setViewMode("timeline");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    setStatus(null);
    try {
      const res = await api.refresh(activeDiseaseId ?? undefined);
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

  const inDiscover = mode === "discover";
  const primaryLabel = inDiscover ? "Timeline" : "Papers";
  const showViewControls = !showSettings && (inDiscover ? !!activeDisease : !!activeCollection);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">🧬</span>
          <h1>SciLuminate</h1>
        </div>
        <div className="header-actions">
          {showViewControls && (
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
          {/* Refresh polls PubMed for the active topic; irrelevant to My Papers. */}
          {!showSettings && inDiscover && activeDisease && (
            <>
              {activeDisease.last_polled_at && (
                <span className="updated">Updated {timeAgo(activeDisease.last_polled_at)}</span>
              )}
              <button className="refresh-btn" onClick={handleRefresh} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh now"}
              </button>
            </>
          )}
          <button
            className={`gear-btn ${showSettings ? "active" : ""}`}
            onClick={() => setShowSettings((s) => !s)}
            aria-label="Settings"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="workspace-bar">
        <WorkspaceNav
          mode={mode}
          onModeChange={changeMode}
          diseases={diseases}
          collections={collections}
          activeDiseaseId={activeDiseaseId}
          activeCollectionId={activeCollectionId}
          settingsActive={showSettings}
          onSelectDisease={selectDisease}
          onSelectCollection={selectCollection}
          onCreateCollection={handleCreateCollection}
          onAddTopic={() => setShowSettings(true)}
        />
      </div>

      {status && <div className="banner info">{status}</div>}

      <main className="app-main">
        {!loaded ? (
          <div className="empty">Loading…</div>
        ) : showSettings ? (
          <Settings onDataChanged={loadDiseases} />
        ) : inDiscover ? (
          activeDisease ? (
            viewMode === "graph" ? (
              <CitationGraph source={{ disease: activeDisease.id }} reloadToken={reloadToken} />
            ) : (
              <Timeline diseaseId={activeDisease.id} reloadToken={reloadToken} />
            )
          ) : (
            <div className="empty">
              No topics yet. Open <strong>⚙ Settings</strong> to add a journal and a MeSH topic to
              watch, or switch to <strong>📁 My Papers</strong> to import your own PDFs.
            </div>
          )
        ) : activeCollection ? (
          viewMode === "graph" ? (
            <CitationGraph source={{ collection: activeCollection.id }} reloadToken={reloadToken} />
          ) : (
            <CollectionView
              key={activeCollection.id}
              collectionId={activeCollection.id}
              onChanged={loadCollections}
              onDeleted={async () => {
                const cs = await loadCollections();
                if (cs.length > 0) setActiveCollectionId(cs[0].id);
                else setActiveCollectionId(null);
              }}
            />
          )
        ) : (
          <div className="empty">
            No collections yet. Click <strong>📁 My Papers → ＋ New collection</strong> to import a
            folder of your own PDFs.
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
