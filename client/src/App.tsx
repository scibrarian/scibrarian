import { useEffect, useState } from "react";
import { api, getAdminToken, setAdminToken, setAuthRejectedHandler } from "./api";
import { errorMessage } from "./lib/format";
import type { AuthStatus, BookmarkFolder, Collection, Topic, PaperSource } from "./types";
import type { Bookmarking } from "./lib/bookmarking";
import { sourceKey } from "./lib/papers";
import { NO_RELOADS, bumpAll, bumpSource, tokenFor, type ReloadTokens } from "./lib/reload";
import { WorkspaceNav, type Mode } from "./components/WorkspaceNav";
import { PaperViews } from "./components/PaperViews";
import { BookmarkFolderView } from "./components/BookmarkFolderView";
import { CollectionView } from "./components/CollectionView";
import { Settings } from "./components/Settings";
import { SkeletonBar, TimelineSkeleton } from "./components/Skeleton";
import { PromptDialog } from "./components/Dialogs";
import { Banner } from "./components/Banner";
import { ViewSwitcher, type ViewMode } from "./components/ViewSwitcher";
import { Dna, Settings as SettingsIcon, Lock, LockOpen, Library, FilePlus, FolderPlus, Plus } from "lucide-react";

export default function App() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [folders, setFolders] = useState<BookmarkFolder[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [mode, setMode] = useState<Mode>("discover");
  const [showSettings, setShowSettings] = useState(false);
  const [activeTopicId, setActiveTopicId] = useState<number | null>(null);
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
  const [activeCollectionId, setActiveCollectionId] = useState<number | null>(null);
  // Each workspace remembers its own view; the defaults match what each is
  // usually for (reading new papers vs. working through papers you've kept).
  const [viewByMode, setViewByMode] = useState<Record<Mode, ViewMode>>({
    discover: "timeline",
    bookmarks: "table",
    papers: "table",
  });
  // Which folders each paper is saved in, keyed by pmid — the whole bookmarks
  // table, held here so every view's icons agree and a toggle repaints without
  // refetching a source's papers (see BookmarkEntry in shared/types).
  const [savedByPmid, setSavedByPmid] = useState<Map<string, Set<number>>>(new Map());
  // Cache invalidation for the paper views, held per source rather than as one
  // global counter (see lib/reload).
  const [reloads, setReloads] = useState<ReloadTokens>(NO_RELOADS);
  const [namingFolder, setNamingFolder] = useState(false);
  const [namingCollection, setNamingCollection] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Whether this browser's requests count as admin (verified server-side via
  // /api/auth — the stored token alone proves nothing). Viewers get a
  // read-only UI; the server enforces the same split regardless.
  const [isAdmin, setIsAdmin] = useState(false);
  // Whether the server has an ADMIN_TOKEN at all. false = tokenless
  // single-user mode, where stored PDFs open directly without minted links.
  // Defaults true (the stricter path) until /api/auth answers.
  const [tokenRequired, setTokenRequired] = useState(true);
  // The owner's Open Library opt-in: viewers download stored PDFs directly.
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  function loadTopics(): Promise<Topic[]> {
    return api
      .getTopics()
      .then((ds) => {
        setTopics(ds);
        // Keep the selection valid against the fresh list: creating the first
        // topic selects it, deleting the active one falls back to the first
        // remaining (instead of a dangling id that renders as no selection).
        setActiveTopicId((cur) =>
          cur != null && ds.some((d) => d.id === cur) ? cur : ds[0]?.id ?? null
        );
        return ds;
      })
      .catch(() => []);
  }

  function loadFolders(): Promise<BookmarkFolder[]> {
    return api
      .getBookmarkFolders()
      .then((fs) => {
        setFolders(fs);
        return fs;
      })
      .catch(() => []);
  }

  function loadBookmarks(): Promise<void> {
    return api
      .getBookmarks()
      .then((rows) => {
        const map = new Map<string, Set<number>>();
        for (const r of rows) {
          const folders = map.get(r.pmid);
          if (folders) folders.add(r.folder_id);
          else map.set(r.pmid, new Set([r.folder_id]));
        }
        setSavedByPmid(map);
      })
      .catch(() => {});
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
    const auth = api
      .getAuth()
      .catch(() => ({ admin: false, token_required: true, library_open: false }));
    Promise.all([loadTopics(), loadFolders(), loadCollections(), auth, loadBookmarks()]).then(
      ([ds, fs, cs, { admin, token_required, library_open }]) => {
        setIsAdmin(admin);
        setTokenRequired(token_required);
        setLibraryOpen(library_open);
        // Preselect each workspace's first entry, then land in the first one
        // that actually has something in it (nav order: Interests, Bookmarks,
        // Library) so switching modes never opens on an empty picker.
        if (fs.length > 0) setActiveFolderId(fs[0].id);
        if (cs.length > 0) setActiveCollectionId(cs[0].id);
        if (ds.length > 0) {
          setMode("discover");
          setActiveTopicId(ds[0].id);
        } else if (fs.length > 0) {
          setMode("bookmarks");
        } else if (cs.length > 0) {
          setMode("papers");
        }
        setLoaded(true);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTopic = topics.find((d) => d.id === activeTopicId) ?? null;
  const activeFolder = folders.find((f) => f.id === activeFolderId) ?? null;
  const activeCollection = collections.find((c) => c.id === activeCollectionId) ?? null;

  const inDiscover = mode === "discover";
  const inLibrary = mode === "papers";
  const viewMode = viewByMode[mode];

  function setViewMode(v: ViewMode) {
    setViewByMode((prev) => ({ ...prev, [mode]: v }));
  }

  function changeMode(m: Mode) {
    setShowSettings(false);
    setMode(m);
    // Entering a workspace with nothing selected falls back to its first entry,
    // so a mode switch always lands on something.
    if (m === "discover" && activeTopicId == null && topics.length > 0) {
      setActiveTopicId(topics[0].id);
    }
    if (m === "bookmarks" && activeFolderId == null && folders.length > 0) {
      setActiveFolderId(folders[0].id);
    }
    if (m === "papers" && activeCollectionId == null && collections.length > 0) {
      setActiveCollectionId(collections[0].id);
    }
  }

  function selectTopic(id: number) {
    setShowSettings(false);
    setMode("discover");
    setActiveTopicId(id);
  }

  function selectFolder(id: number) {
    setShowSettings(false);
    setMode("bookmarks");
    setActiveFolderId(id);
  }

  function selectCollection(id: number) {
    setShowSettings(false);
    setMode("papers");
    setActiveCollectionId(id);
  }

  // Data under a papers view changed (poll, import, match, file delete, a paper
  // saved): invalidate that source's caches so the next look at it refetches.
  // What moved isn't always what's on screen — saving from Interests has to
  // leave the folder's list stale while the topic being read stays cached.
  function reloadSource(source: PaperSource) {
    setReloads((t) => bumpSource(t, sourceKey(source)));
  }

  // The changes no single source owns: a poll across every topic, papers
  // removed from Interests wholesale, or a deleted source — that last one
  // because SQLite may hand the dead id to the next source created, which would
  // then inherit its cache entries.
  function reloadEverything() {
    setReloads((t) => bumpAll(t));
  }

  // Create a folder and stay put — what the bookmark menu needs, since the
  // point there is to save the paper you're looking at, not to navigate away.
  async function createFolderNamed(name: string): Promise<BookmarkFolder> {
    const created = await api.createBookmarkFolder(name);
    await loadFolders();
    return created;
  }

  // The picker's "New folder" instead opens the folder it just made.
  async function createFolder(name: string) {
    setNamingFolder(false);
    try {
      const created = await createFolderNamed(name);
      setShowSettings(false);
      setMode("bookmarks");
      setActiveFolderId(created.id);
      setViewByMode((prev) => ({ ...prev, bookmarks: "table" }));
    } catch (e) {
      setStatus(errorMessage(e));
    }
  }

  // A bookmark toggle updates the in-memory map rather than invalidating the
  // papers cache: in Interests the rows themselves don't change, only the icon,
  // and refetching a few thousand papers per click would be absurd. The folder
  // is the exception — its membership *is* its paper list — so each toggle
  // invalidates that one folder, on screen or not.
  function applySaved(pmid: string, update: (folders: Set<number>) => void) {
    setSavedByPmid((prev) => {
      const next = new Map(prev);
      const folders = new Set(next.get(pmid) ?? []);
      update(folders);
      if (folders.size > 0) next.set(pmid, folders);
      else next.delete(pmid);
      return next;
    });
  }

  async function addBookmark(folderId: number, pmid: string) {
    await api.addBookmarks(folderId, [pmid]);
    applySaved(pmid, (folders) => folders.add(folderId));
    await loadFolders();
    reloadSource({ folder: folderId });
  }

  // The bulk save. Papers the server skipped as unstored would leave the map
  // claiming they're saved, so the whole map is reloaded from the server rather
  // than patched — one request, and it can't drift.
  async function addBookmarks(folderId: number, pmids: string[]) {
    const result = await api.addBookmarks(folderId, pmids);
    await Promise.all([loadBookmarks(), loadFolders()]);
    reloadSource({ folder: folderId });
    return result;
  }

  async function removeBookmark(folderId: number, pmid: string) {
    await api.removeBookmark(folderId, pmid);
    applySaved(pmid, (folders) => folders.delete(folderId));
    await loadFolders();
    reloadSource({ folder: folderId });
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

  // Both are the shell reporting a change to the source it wraps, so only that
  // source's caches go — the folder listing / collection files are refetched by
  // the load above, not by the token.
  async function handleFolderChanged() {
    await loadFolders();
    if (activeFolderId != null) reloadSource({ folder: activeFolderId });
  }

  async function handleCollectionChanged() {
    await loadCollections();
    if (activeCollectionId != null) reloadSource({ collection: activeCollectionId });
  }

  // Try a pasted admin token: store it, then let the server judge it.
  async function unlock(token: string) {
    setUnlocking(false);
    setAdminToken(token.trim());
    const { admin } = await api
      .getAuth()
      .catch(() => ({ admin: false, token_required: true, library_open: false }));
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

  // A title click in any view re-fetches /auth to decide PDF access; fold that
  // fresh snapshot back into app state so the whole UI (share column, tooltips,
  // file badges) reflects a mid-session Open Library or token change.
  function handleAuthRefreshed(a: AuthStatus) {
    setIsAdmin(a.admin);
    setTokenRequired(a.token_required);
    setLibraryOpen(a.library_open);
  }

  async function handleRefresh() {
    setRefreshing(true);
    setStatus(null);
    try {
      const countPapers = (ds: Topic[]) => ds.reduce((s, d) => s + (d.articleCount ?? 0), 0);
      const before = countPapers(topics);
      const res = await api.refresh(activeTopicId ?? undefined);
      const added = res.results.reduce((s, r) => s + r.added, 0);
      const errs = res.results.filter((r) => r.error);
      const after = countPapers(await loadTopics());
      // Polling only adds, but papers can leave the feeds between refreshes
      // (e.g. a journal removal); surface that instead of just "Added 0".
      const removed = Math.max(0, before + added - after);
      let msg = `Added ${added} new paper${added === 1 ? "" : "s"}.`;
      if (removed > 0) msg += ` Removed ${removed} paper${removed === 1 ? "" : "s"}.`;
      if (errs.length) msg += ` ${errs.length} error(s): ${errs.map((e) => e.error).join("; ")}`;
      setStatus(msg);
      // /refresh polls the active topic, and every topic when there is none.
      if (activeTopicId != null) reloadSource({ topic: activeTopicId });
      else reloadEverything();
    } catch (e) {
      setStatus(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  // The active paper source, if this mode has something selected.
  const source: PaperSource | null = inDiscover
    ? activeTopic && { topic: activeTopic.id }
    : inLibrary
      ? activeCollection && { collection: activeCollection.id }
      : activeFolder && { folder: activeFolder.id };
  const showViewControls = !showSettings && source != null;
  // The token every cached fetch under this source is stamped with; a bump to
  // any other source leaves it alone, so the views keep painting from cache.
  const reloadToken = source ? tokenFor(reloads, sourceKey(source)) : 0;

  // The truly-empty message differs by source: topics fill from PubMed,
  // collections fill from uploads, folders from papers the user saves. Viewers
  // get a variant that doesn't point at controls they don't have.
  const emptyState = !isAdmin ? (
    <>No papers here yet. The site owner hasn’t added any.</>
  ) : inDiscover ? (
    <>
      No papers yet. Add journals &amp; topics in{" "}
      <strong><SettingsIcon size={14} className="inline-icon" aria-hidden /> Settings</strong>, then
      click “Check for new papers”.
    </>
  ) : inLibrary ? (
    <>
      No papers yet. Click{" "}
      <strong><FilePlus size={14} className="inline-icon" aria-hidden /> Add files</strong> or{" "}
      <strong><FolderPlus size={14} className="inline-icon" aria-hidden /> Add folder</strong> to
      upload PDFs. The app scans each PDF for its PubMed ID and pulls in the title, authors,
      journal, year, and citation count.
    </>
  ) : (
    <>No papers in this folder yet.</>
  );

  // Same idea one level up: nothing is selected because this workspace has no
  // entries at all.
  const noSourceState = !isAdmin ? (
    <>
      Nothing here yet. The site owner hasn’t added any{" "}
      {inDiscover ? "topics" : inLibrary ? "collections" : "bookmark folders"}.
    </>
  ) : inDiscover ? (
    <>
      No topics yet. Open{" "}
      <strong><SettingsIcon size={14} className="inline-icon" aria-hidden /> Settings</strong> to add
      a journal and a MeSH topic to watch, or switch to{" "}
      <strong><Library size={14} className="inline-icon" aria-hidden /> Library</strong> to import
      your own PDFs.
    </>
  ) : inLibrary ? (
    <>
      No collections yet. Click{" "}
      <strong><Plus size={14} className="inline-icon" aria-hidden /> New collection</strong> in the
      collections dropdown to import your own PDFs.
    </>
  ) : (
    <>
      No bookmark folders yet. Click{" "}
      <strong><Plus size={14} className="inline-icon" aria-hidden /> New folder</strong> in the
      folders dropdown to make one.
    </>
  );

  // Every view opens papers the same way, so they all take the same access
  // snapshot (see usePaperOpener).
  const access = {
    isAdmin,
    tokenRequired,
    libraryOpen,
    onAuthRefreshed: handleAuthRefreshed,
  };

  // Bookmarking is offered where a paper is still a candidate: Interests (save
  // what the search turned up) and Bookmarks (unsave, or file it into a second
  // folder). Not the Library — those are papers you already own, not ones
  // you're deciding about — and not for viewers, since saving is a mutation the
  // server would refuse and a control that always fails is worse than none.
  // null is what keeps the control out.
  //
  // Both halves of that rule live here rather than in the views. Each view used
  // to re-derive the viewer half itself, three ways, and one of them answered
  // `false` where the others answered null — which is how an empty filter row
  // ended up rendering for anyone who wasn't the owner.
  const bookmarking: Bookmarking | null =
    inLibrary || !isAdmin
      ? null
      : {
          folders,
          saved: savedByPmid,
          add: addBookmark,
          addMany: addBookmarks,
          remove: removeBookmark,
          createFolder: createFolderNamed,
        };

  const module = source && (
    <PaperViews
      source={source}
      viewMode={viewMode}
      reloadToken={reloadToken}
      emptyState={emptyState}
      access={access}
      bookmarking={bookmarking}
    />
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo"><Dna aria-hidden /></span>
          <h1>Scibrarian</h1>
          <span className="version">v{__APP_VERSION__}</span>
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
                <ViewSwitcher viewMode={viewMode} onChange={setViewMode} />
              )}
              {isAdmin && (
                <button
                  className={`gear-btn ${showSettings ? "active" : ""}`}
                  onClick={() => setShowSettings((s) => !s)}
                  aria-label="Settings"
                  title="Settings"
                >
                  <SettingsIcon size={16} aria-hidden />
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
                  <Lock size={16} aria-hidden />
                </button>
              )}
              {isAdmin && getAdminToken() != null && (
                <button
                  className="gear-btn"
                  onClick={lock}
                  aria-label="Leave admin mode"
                  title="Leave admin mode"
                >
                  <LockOpen size={16} aria-hidden />
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
          topics={topics}
          folders={folders}
          collections={collections}
          activeTopicId={activeTopicId}
          activeFolderId={activeFolderId}
          activeCollectionId={activeCollectionId}
          settingsActive={showSettings}
          loaded={loaded}
          tokenRequired={tokenRequired}
          onSelectTopic={selectTopic}
          onSelectFolder={selectFolder}
          onSelectCollection={selectCollection}
          onCreateFolder={() => setNamingFolder(true)}
          onCreateCollection={() => setNamingCollection(true)}
          onAddTopic={() => setShowSettings(true)}
          onShareError={setStatus}
        />
      </div>

      {status && <Banner kind="info" message={status} onDismiss={() => setStatus(null)} />}

      <main className="app-main">
        {!loaded ? (
          // Reserve the action row too, so the papers don't jump down a row's
          // height the moment the skeleton is replaced (mirrors the header).
          <div className="source-view">
            <div className="source-head" aria-hidden="true">
              <SkeletonBar w={190} h={33} style={{ borderRadius: "var(--radius)" }} />
            </div>
            <TimelineSkeleton withToolbar />
          </div>
        ) : showSettings ? (
          <Settings
            onDataChanged={loadTopics}
            onPapersRemoved={(count) => {
              setStatus(`Removed ${count} paper${count === 1 ? "" : "s"} from Interests.`);
              // A journal or topic removal sweeps papers out of any number of
              // topics at once, so nothing narrower than everything is safe.
              reloadEverything();
            }}
          />
        ) : !source ? (
          <div className="empty">{noSourceState}</div>
        ) : inDiscover ? (
          // Every workspace puts its source-scoped actions in the same row, in
          // the same place, in every view — so the papers below start at one
          // vertical position and switching workspace or view doesn't shift
          // them. A topic's actions are polling ones: when it last ran, and
          // running it now.
          <div className="source-view">
            <div className="source-head">
              <div className="source-actions">
                {activeTopic?.last_polled_at && (
                  <span className="updated">Updated {timeAgo(activeTopic.last_polled_at)}</span>
                )}
                {isAdmin && (
                  <button className="refresh-btn" onClick={handleRefresh} disabled={refreshing}>
                    {refreshing && <span className="btn-spinner" aria-hidden="true" />}
                    {refreshing ? "Checking…" : "Check for new papers"}
                  </button>
                )}
              </div>
            </div>
            {module}
          </div>
        ) : inLibrary ? (
          <CollectionView
            key={activeCollectionId}
            collectionId={activeCollectionId!}
            isAdmin={isAdmin}
            reloadToken={reloadToken}
            // The graph fills the main area itself, so the collection's long
            // unmatched-files list is suppressed under it; the action row and
            // any live import progress still show, as they do in every view.
            showUnmatched={viewMode !== "graph"}
            onChanged={handleCollectionChanged}
            onDeleted={async () => {
              const cs = await loadCollections();
              setActiveCollectionId(cs.length > 0 ? cs[0].id : null);
              reloadEverything();
            }}
          >
            {module}
          </CollectionView>
        ) : (
          <BookmarkFolderView
            key={activeFolderId}
            folderId={activeFolderId!}
            isAdmin={isAdmin}
            onChanged={handleFolderChanged}
            onDeleted={async () => {
              const fs = await loadFolders();
              setActiveFolderId(fs.length > 0 ? fs[0].id : null);
              reloadEverything();
            }}
          >
            {module}
          </BookmarkFolderView>
        )}
      </main>

      <PromptDialog
        open={namingFolder}
        title="New folder"
        placeholder="Folder name"
        submitLabel="Create"
        onSubmit={createFolder}
        onCancel={() => setNamingFolder(false)}
      />

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
