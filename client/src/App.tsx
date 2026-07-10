import { useEffect, useState } from "react";
import { api, getAdminToken, setAdminToken, setAuthRejectedHandler } from "./api";
import { errorMessage } from "./lib/format";
import type { Collection, Disease, PaperSource } from "./types";
import { WorkspaceNav, type Mode } from "./components/WorkspaceNav";
import { Timeline } from "./components/Timeline";
import { CitationGraph } from "./components/CitationGraph";
import { PapersTable } from "./components/PapersTable";
import { CollectionView } from "./components/CollectionView";
import { Settings } from "./components/Settings";
import { SkeletonBar, TimelineSkeleton } from "./components/Skeleton";
import { PromptDialog } from "./components/Dialogs";

type ViewMode = "table" | "timeline" | "graph";

export default function App() {
  const [diseases, setDiseases] = useState<Disease[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [mode, setMode] = useState<Mode>("discover");
  const [showSettings, setShowSettings] = useState(false);
  const [activeDiseaseId, setActiveDiseaseId] = useState<number | null>(null);
  const [activeCollectionId, setActiveCollectionId] = useState<number | null>(null);
  // Each workspace remembers its own view; the defaults match what each is
  // usually for (reading new papers vs. managing a library).
  const [viewByMode, setViewByMode] = useState<Record<Mode, ViewMode>>({
    discover: "timeline",
    papers: "table",
  });
  const [reloadToken, setReloadToken] = useState(0);
  const [namingCollection, setNamingCollection] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Whether this browser's requests count as admin (verified server-side via
  // /api/auth — the stored token alone proves nothing). Viewers get a
  // read-only UI; the server enforces the same split regardless.
  const [isAdmin, setIsAdmin] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

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
    // A 401 on any later call means the stored token was rotated/revoked;
    // api.ts drops the token, this demotes the UI to viewer mode.
    setAuthRejectedHandler(() => setIsAdmin(false));
    // Admin state resolves with the same `loaded` flip so the admin controls
    // don't pop in after the skeletons clear.
    const auth = api.getAuth().catch(() => ({ admin: false }));
    Promise.all([loadDiseases(), loadCollections(), auth]).then(([ds, cs, { admin }]) => {
      setIsAdmin(admin);
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

  const inDiscover = mode === "discover";
  const viewMode = viewByMode[mode];

  function setViewMode(v: ViewMode) {
    setViewByMode((prev) => ({ ...prev, [mode]: v }));
  }

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

  // Data under the papers views changed (poll, import, match, file delete):
  // invalidate every module's cache so the active one refetches.
  function bumpReloadToken() {
    setReloadToken((t) => t + 1);
  }

  async function createCollection(name: string) {
    setNamingCollection(false);
    try {
      const created = await api.createCollection(name);
      await loadCollections();
      setShowSettings(false);
      setMode("papers");
      setActiveCollectionId(created.id);
      setViewByMode((prev) => ({ ...prev, papers: "table" }));
    } catch (e) {
      setStatus(errorMessage(e));
    }
  }

  async function handleCollectionChanged() {
    await loadCollections();
    bumpReloadToken();
  }

  // Try a pasted admin token: store it, then let the server judge it.
  async function unlock(token: string) {
    setUnlocking(false);
    setAdminToken(token.trim());
    const { admin } = await api.getAuth().catch(() => ({ admin: false }));
    setIsAdmin(admin);
    if (!admin) {
      setAdminToken(null);
      setStatus("That admin token wasn't accepted.");
    }
  }

  function lock() {
    setAdminToken(null);
    setIsAdmin(false);
  }

  async function handleRefresh() {
    setRefreshing(true);
    setStatus(null);
    try {
      const countPapers = (ds: Disease[]) => ds.reduce((s, d) => s + (d.articleCount ?? 0), 0);
      const before = countPapers(diseases);
      const res = await api.refresh(activeDiseaseId ?? undefined);
      const added = res.results.reduce((s, r) => s + r.added, 0);
      const errs = res.results.filter((r) => r.error);
      const after = countPapers(await loadDiseases());
      // Polling only adds, but papers can leave the feeds between refreshes
      // (e.g. a journal removal); surface that instead of just "Added 0".
      const removed = Math.max(0, before + added - after);
      let msg = `Added ${added} new paper${added === 1 ? "" : "s"}.`;
      if (removed > 0) msg += ` Removed ${removed} paper${removed === 1 ? "" : "s"}.`;
      if (errs.length) msg += ` ${errs.length} error(s): ${errs.map((e) => e.error).join("; ")}`;
      setStatus(msg);
      bumpReloadToken();
    } catch (e) {
      setStatus(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  // The active paper source, if a topic/collection is selected in this mode.
  const source: PaperSource | null = inDiscover
    ? activeDisease && { disease: activeDisease.id }
    : activeCollection && { collection: activeCollection.id };
  const showViewControls = !showSettings && source != null;

  // The truly-empty message differs by source: topics fill from PubMed,
  // collections fill from uploads. Viewers get a variant that doesn't point
  // at controls they don't have.
  const emptyState = !isAdmin ? (
    <>No papers here yet. The site owner hasn’t added any.</>
  ) : inDiscover ? (
    <>
      No papers yet. Add journals &amp; diseases in <strong>⚙ Settings</strong>, then click
      “Refresh now”.
    </>
  ) : (
    <>
      No papers yet. Click <strong>+ Add files</strong> or <strong>+ Add folder</strong> to upload
      PDFs. The app scans each PDF for its PubMed ID and pulls in the title, authors, journal,
      year, and citation count.
    </>
  );

  const module =
    source &&
    (viewMode === "graph" ? (
      <CitationGraph source={source} reloadToken={reloadToken} />
    ) : viewMode === "timeline" ? (
      <Timeline source={source} reloadToken={reloadToken} emptyState={emptyState} />
    ) : (
      <PapersTable source={source} reloadToken={reloadToken} emptyState={emptyState} />
    ));

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">🧬</span>
          <h1>SciLuminate</h1>
        </div>
        <div className="header-actions">
          {!loaded ? (
            // Reserve the controls' space during the first load so they don't
            // pop in and shift the header once data arrives.
            <>
              <SkeletonBar w={150} h={32} style={{ borderRadius: "var(--radius)" }} />
              <SkeletonBar w={108} h={35} style={{ borderRadius: "var(--radius)" }} />
            </>
          ) : (
            <>
              {showViewControls && (
                <div className="view-toggle" role="group" aria-label="View mode">
                  <button
                    className={viewMode === "table" ? "active" : ""}
                    onClick={() => setViewMode("table")}
                  >
                    Papers
                  </button>
                  <button
                    className={viewMode === "timeline" ? "active" : ""}
                    onClick={() => setViewMode("timeline")}
                  >
                    Timeline
                  </button>
                  <button
                    className={viewMode === "graph" ? "active" : ""}
                    onClick={() => setViewMode("graph")}
                  >
                    Graph
                  </button>
                </div>
              )}
              {/* Refresh polls PubMed for the active topic; irrelevant to Library. */}
              {!showSettings && inDiscover && activeDisease && (
                <>
                  {activeDisease.last_polled_at && (
                    <span className="updated">Updated {timeAgo(activeDisease.last_polled_at)}</span>
                  )}
                  {isAdmin && (
                    <button className="refresh-btn" onClick={handleRefresh} disabled={refreshing}>
                      {refreshing ? "Refreshing…" : "Refresh now"}
                    </button>
                  )}
                </>
              )}
              {isAdmin && (
                <button
                  className={`gear-btn ${showSettings ? "active" : ""}`}
                  onClick={() => setShowSettings((s) => !s)}
                  aria-label="Settings"
                  title="Settings"
                >
                  ⚙
                </button>
              )}
              {/* Padlock: viewers can unlock admin mode; an unlocked admin can
                  relock. In tokenless single-user mode neither renders. */}
              {!isAdmin && (
                <button
                  className="gear-btn"
                  onClick={() => setUnlocking(true)}
                  aria-label="Admin unlock"
                  title="Admin unlock"
                >
                  🔒
                </button>
              )}
              {isAdmin && getAdminToken() != null && (
                <button
                  className="gear-btn"
                  onClick={lock}
                  aria-label="Leave admin mode"
                  title="Leave admin mode"
                >
                  🔓
                </button>
              )}
            </>
          )}
        </div>
      </header>

      <div className="workspace-bar">
        <WorkspaceNav
          mode={mode}
          isAdmin={isAdmin}
          onModeChange={changeMode}
          diseases={diseases}
          collections={collections}
          activeDiseaseId={activeDiseaseId}
          activeCollectionId={activeCollectionId}
          settingsActive={showSettings}
          loaded={loaded}
          onSelectDisease={selectDisease}
          onSelectCollection={selectCollection}
          onCreateCollection={() => setNamingCollection(true)}
          onAddTopic={() => setShowSettings(true)}
        />
      </div>

      {status && (
        <div className="banner info dismissible">
          <span>{status}</span>
          <button className="banner-close" onClick={() => setStatus(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className="app-main">
        {!loaded ? (
          <TimelineSkeleton withToolbar />
        ) : showSettings ? (
          <Settings
            onDataChanged={loadDiseases}
            onPapersRemoved={(count) => {
              setStatus(`Removed ${count} paper${count === 1 ? "" : "s"} from Interests.`);
              bumpReloadToken();
            }}
          />
        ) : !source ? (
          <div className="empty">
            {!isAdmin ? (
              <>
                Nothing here yet. The site owner hasn’t added any{" "}
                {inDiscover ? "topics" : "collections"}.
              </>
            ) : inDiscover ? (
              <>
                No topics yet. Open <strong>⚙ Settings</strong> to add a journal and a MeSH topic
                to watch, or switch to <strong>📚 Library</strong> to import your own PDFs.
              </>
            ) : (
              <>
                No collections yet. Click <strong>＋ New collection</strong> in the collections dropdown to
                import your own PDFs.
              </>
            )}
          </div>
        ) : inDiscover || viewMode === "graph" ? (
          // The graph fills the main area itself; the collection shell wraps
          // only the table/timeline, where its chrome belongs.
          module
        ) : (
          <CollectionView
            key={activeCollectionId}
            collectionId={activeCollectionId!}
            isAdmin={isAdmin}
            reloadToken={reloadToken}
            onChanged={handleCollectionChanged}
            onDeleted={async () => {
              const cs = await loadCollections();
              setActiveCollectionId(cs.length > 0 ? cs[0].id : null);
              bumpReloadToken();
            }}
          >
            {module}
          </CollectionView>
        )}
      </main>

      <PromptDialog
        open={namingCollection}
        title="New collection"
        placeholder="Collection name"
        submitLabel="Create"
        onSubmit={createCollection}
        onCancel={() => setNamingCollection(false)}
      />

      <PromptDialog
        open={unlocking}
        title="Admin unlock"
        placeholder="Admin token"
        inputType="password"
        submitLabel="Unlock"
        onSubmit={unlock}
        onCancel={() => setUnlocking(false)}
      />
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
