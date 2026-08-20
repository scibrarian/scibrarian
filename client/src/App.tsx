import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, getAdminToken, setAdminToken, setAuthRejectedHandler } from "./api";
import { errorMessage } from "./lib/format";
import type {
  AuthStatus,
  BookmarkFolder,
  Collection,
  CollectionSelection,
  Topic,
  PaperSource,
  ProCollectionStamp,
  ProStatus,
} from "./types";
import type { Bookmarking } from "./lib/bookmarking";
import { seedEmptySource, sourceKey } from "./lib/papers";
import { NO_RELOADS, bumpAll, bumpSource, tokenFor, type ReloadTokens } from "./lib/reload";
import { WorkspaceNav, MODES, type Mode } from "./components/WorkspaceNav";
import { PaperViews } from "./components/PaperViews";
import { BookmarkFolderView } from "./components/BookmarkFolderView";
import { CollectionView } from "./components/CollectionView";
import { Settings } from "./components/Settings";
import { SkeletonBar, TimelineSkeleton } from "./components/Skeleton";
import { PromptDialog } from "./components/Dialogs";
import { Banner } from "./components/Banner";
import { ViewSwitcher, ViewSwitcherSkeleton, type ViewMode } from "./components/ViewSwitcher";
import { HaveCheck, HAVE_CHECK_TITLE } from "./components/HaveCheck";
import {
  Dna,
  Settings as SettingsIcon,
  Lock,
  LockOpen,
  FilePlus,
  Plus,
  RotateCw,
  SearchCheck,
} from "lucide-react";
import { MAX_NAME_CHARS } from "../../shared/limits";

// The prose below points at the Library workspace by name and glyph, so it
// takes both from the nav's MODES rather than picking an icon of its own that
// could drift from the one the mode switch draws. Aliased because JSX needs a
// capitalized binding to treat it as a component.
const LibraryIcon = MODES.papers.icon;

// Whether two readings of the organisation stamps say the same thing, so an
// unchanged one can be dropped rather than re-rendering everything drawn from
// it. See applyStamps.
//
// Compared as JSON rather than field by field. Both sides are parsed from the
// same endpoint, so key order cannot differ, and a field added to the stamp
// stays in the comparison instead of silently dropping out of it — which would
// mean the UI stopped re-rendering for exactly the field someone had just
// decided was worth sending.
function sameStamps(a: ProCollectionStamp[], b: ProCollectionStamp[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

export default function App() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [folders, setFolders] = useState<BookmarkFolder[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [mode, setMode] = useState<Mode>("papers");
  const [showSettings, setShowSettings] = useState(false);
  const [activeTopicId, setActiveTopicId] = useState<number | null>(null);
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
  const [activeCollectionId, setActiveCollectionId] = useState<CollectionSelection | null>(null);
  // Each workspace remembers its own view; the defaults match what each is
  // usually for (reading new papers vs. working through papers you've kept).
  const [viewByMode, setViewByMode] = useState<Record<Mode, ViewMode>>({
    interests: "timeline",
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
  // "Do I already have this?" lives in the header rather than inside a
  // workspace: the question arrives from outside the app (an assignment, a
  // reference list someone sent) and has to be askable without first navigating
  // to the right collection — or knowing which collection would hold it.
  const [checkingHave, setCheckingHave] = useState(false);
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
  // The Pro module's report, or null in a free build. Everything Pro-related in
  // the UI hangs off this being non-null, so a free build renders none of it
  // without a single feature check of its own.
  const [pro, setPro] = useState<ProStatus | null>(null);
  // Which collections carry an organisation stamp. Kept here rather than in the
  // Library view because two places draw from it — the picker's icon, which is
  // rendered by the nav above that view, and the badge inside it.
  const [stamps, setStamps] = useState<ProCollectionStamp[]>([]);
  // Ticket taken by each reading of the stamps and checked when it lands, so a
  // slow answer cannot overwrite a faster one that started after it. Counting
  // reads rather than tracking one request, because the panel supplies a
  // reading directly and that has to make an outstanding request stale too.
  const stampsRead = useRef(0);
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

  /**
   * Take a reading of the stamps as the current one, and make any request still
   * in the air stale.
   *
   * Every write to `stamps` goes through here, because two orderings are
   * otherwise decided by which response happens to land last. The padlock is
   * one: lock() clears `pro` while a /api/pro/sync started by the last /auth
   * refresh is still out, and that answer arriving afterwards puts organisation
   * names back on screen in a UI that has just dropped its privileges. Sharing
   * a collection from the panel is the other, in the same window and the other
   * direction — the stamp the owner just removed comes back.
   *
   * Unchanged readings are dropped rather than re-set. The effect below re-reads
   * on every /auth refresh, which a paper-title click triggers, and nearly all
   * of those readings say exactly what the last one did; handing back the array
   * we already hold makes React bail out of the update, where a fresh array of
   * identical rows would invalidate both memos below and re-render the nav and
   * the whole papers subtree for a state that did not move.
   */
  function applyStamps(next: ProCollectionStamp[]): void {
    stampsRead.current++;
    setStamps((cur) => (sameStamps(cur, next) ? cur : next));
  }

  /**
   * The organisation stamps, or the last ones we had.
   *
   * Swallows every failure on purpose, and this is the one caller where that is
   * right rather than lazy: the stamps are decoration over a fact the rest of
   * the UI already has, so a build without the module, a Pro module too old to
   * serve /api/pro/sync, and a viewer whose request the admin gate refuses must
   * all end the same way — no badges, everything else working. Each of those
   * arrives at an empty list by never having filled one.
   *
   * A *failure* is not one of them, and used to be treated as one. The badge
   * reads absence as "local" rather than as nothing known, so blanking the list
   * on a dropped request does not go quiet — it says these collections are
   * local, which is the one thing it must never say wrongly, and it says it
   * after a server restart or a lost second of wifi. The demotion that means
   * "you may not see these" announces itself through setAuthRejectedHandler
   * below instead of being inferred from a request that didn't come back.
   */
  function loadStamps(): Promise<void> {
    const read = ++stampsRead.current;
    return api
      .proSync()
      .then((s) => {
        if (read === stampsRead.current) applyStamps(s.stamps);
      })
      .catch(() => {});
  }

  // Stamps are a fact about the collections *and* the pairing, so both are
  // dependencies: creating or deleting a collection changes the list, and
  // pairing or disconnecting changes what `active` means for every row of it.
  // Sharing one from the panel in Settings is the only change neither
  // dependency can see, which is why that reports back through
  // handleSharingChanged.
  //
  // Gated on a Pro block rather than on is_paired: an instance that has since
  // disconnected still holds stamps, and they are exactly what the faded badge
  // exists to show. /auth sends the block to the owner alone, so a viewer never
  // asks.
  //
  // `pro` is depended on as an object, which re-reads on every /auth refresh —
  // including the one behind each paper-title click. That is deliberate, and
  // narrowing it to `pro?.is_paired` is the tempting change that breaks it:
  // re-pairing to a *different* organisation leaves that flag true from first
  // to last, while flipping `active` on every stamp the badge and icon draw
  // from. ProStatus carries nothing identifying the master, so the object is
  // the only dependency that notices. One small local GET is the price — and
  // only the GET: applyStamps drops the answer when it matches what is already
  // held, so the re-read a title click causes costs nothing on screen.
  useEffect(() => {
    if (!pro) {
      // Through applyStamps rather than setStamps, so relocking also invalidates
      // the request the last refresh left in the air. That request is the one
      // that used to repopulate the badges a moment after the padlock.
      applyStamps([]);
      return;
    }
    void loadStamps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pro, collections]);

  useEffect(() => {
    // A 401 on any later call means the stored token was rotated/revoked;
    // api.ts drops the token, this demotes the UI to viewer mode.
    //
    // The stamps go with the privileges. loadStamps no longer reads a failed
    // request as "no stamps", so this is where the one failure that really does
    // mean that gets said — otherwise a revoked owner keeps every badge until
    // the next /auth refresh notices the Pro block has gone.
    setAuthRejectedHandler(() => {
      setIsAdmin(false);
      applyStamps([]);
    });
    // Admin state resolves with the same `loaded` flip so the admin controls
    // don't pop in after the skeletons clear.
    // null rather than a viewer-shaped fallback, so the handler below can tell
    // "the server said you are not admin" from "we couldn't ask it".
    const auth = api.getAuth().catch(() => null);
    Promise.all([loadTopics(), loadFolders(), loadCollections(), auth, loadBookmarks()]).then(
      ([ds, fs, cs, status]) => {
        const { admin, token_required, library_open } = status ?? {
          admin: false,
          token_required: true,
          library_open: false,
        };
        // A stored token the server has just refused is dead weight. /api/auth
        // answers 200 with admin:false rather than 401, so the 401 path in
        // api.ts never clears it — and nothing else would either, because a
        // demoted viewer makes no mutating calls to get a 401 from. Left alone
        // it sits in localStorage forever, telling every later load's header
        // skeleton to reserve an admin button that never lands. Only on a real
        // answer: a request that failed is not the server saying no, and
        // dropping a good token because the network blinked would lock an admin
        // out of their own instance.
        if (status && !admin) setAdminToken(null);
        setIsAdmin(admin);
        setTokenRequired(token_required);
        setLibraryOpen(library_open);
        setPro(status?.pro ?? null);
        // Preselect each workspace's first entry, then land in the first one
        // that actually has something in it (nav order: Library, Interests,
        // Bookmarks) so switching modes never opens on an empty picker.
        if (fs.length > 0) setActiveFolderId(fs[0].id);
        if (ds.length > 0) setActiveTopicId(ds[0].id);
        if (cs.length > 0) {
          setMode("papers");
          setActiveCollectionId(cs[0].id);
        } else if (ds.length > 0) {
          setMode("interests");
        } else if (fs.length > 0) {
          setMode("bookmarks");
        }
        setLoaded(true);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTopic = topics.find((d) => d.id === activeTopicId) ?? null;
  const activeFolder = folders.find((f) => f.id === activeFolderId) ?? null;
  const activeCollection = collections.find((c) => c.id === activeCollectionId) ?? null;

  // The two shapes the stamps are read in, built once rather than per render:
  // this component re-renders on every id, banner and refresh change, and both
  // of these are handed to children that would otherwise see a new object each
  // time. The set is only the *active* stamps — see PickerItem.shared for why
  // the icon answers a narrower question than the badge does.
  const sharedCollectionIds = useMemo(
    () => new Set(stamps.filter((s) => s.active).map((s) => s.collection_id)),
    [stamps]
  );
  const stampByCollection = useMemo(
    () => new Map(stamps.map((s) => [s.collection_id, s])),
    [stamps]
  );

  const inInterests = mode === "interests";
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
    if (m === "interests" && activeTopicId == null && topics.length > 0) {
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
    setMode("interests");
    setActiveTopicId(id);
  }

  function selectFolder(id: number) {
    setShowSettings(false);
    setMode("bookmarks");
    setActiveFolderId(id);
  }

  function selectCollection(id: CollectionSelection) {
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

  // Creating a source and opening it are one gesture, so the view it lands on
  // would fetch a paper list the app already knows the answer to — and that
  // request is slow enough to paint a skeleton on the way to an empty state
  // that was never in doubt. Answering it from here makes the first paint the
  // real one. Only ever called for a source created a moment ago; see
  // seedEmptySource for why that restriction matters.
  function seedNewSource(source: PaperSource) {
    seedEmptySource(source, tokenFor(reloads, sourceKey(source)));
  }

  // The picker's "New folder" instead opens the folder it just made.
  async function createFolder(name: string) {
    setNamingFolder(false);
    try {
      const created = await createFolderNamed(name);
      setShowSettings(false);
      setMode("bookmarks");
      seedNewSource({ folder: created.id });
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

  async function createCollection(name: string, shareWithOrg: boolean) {
    setNamingCollection(false);
    try {
      const created = await api.createCollection(name);
      // Stamped immediately, from the pairing that was live when it was made.
      // That ordering is the point: a boundary set later is one the writer
      // forgets, and one derived from the *current* pairing would hand an old
      // client's collections to a new one the moment they re-pair.
      //
      // A failure here must not lose the collection — it exists and the writer
      // is about to be dropped into it, so the stamp is reported and skipped
      // rather than unwound.
      if (shareWithOrg && pro?.is_paired) {
        try {
          await api.proShareCollection(created.id);
        } catch (e) {
          setStatus(`Collection created, but sharing couldn't be set up: ${errorMessage(e)}`);
        }
      }
      await loadCollections();
      setShowSettings(false);
      setMode("papers");
      seedNewSource({ collection: created.id });
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
    // Both, not just whichever is on screen: the all-collections view aggregates
    // every collection, so a change to any one of them makes it stale too, and
    // bumping only the active source would leave a switch to All Collections
    // painting from a cache that predates the change.
    reloadSource({ allCollections: true });
    if (typeof activeCollectionId === "number") reloadSource({ collection: activeCollectionId });
  }

  // Try a pasted admin token: store it, then let the server judge it.
  async function unlock(token: string) {
    setUnlocking(false);
    setAdminToken(token.trim());
    const { admin, pro: proStatus } = await api
      .getAuth()
      .catch(() => ({ admin: false, token_required: true, library_open: false, pro: null }));
    setIsAdmin(admin);
    // /auth reports the Pro block to the owner only, so a viewer's first load
    // always answered null for it. Without this, unlocking reveals the gear but
    // Settings still renders without the shared-holdings panel until a reload —
    // which is every token-protected instance's only route to it.
    setPro(proStatus ?? null);
    if (!admin) {
      setAdminToken(null);
      setStatus("That admin token wasn't accepted.");
    }
  }

  function lock() {
    setAdminToken(null);
    setIsAdmin(false);
    // Relocking hides the gear but leaves showSettings true, so the page keeps
    // rendering. Dropping this would leave the org's node count and module
    // version on screen for a viewer — the exact thing keeping `pro` owner-only
    // is meant to prevent.
    setPro(null);
  }

  // The panel shared or stopped sharing one collection. Narrower than a pairing
  // change on purpose: nothing about `pro` moved, so re-reading /auth here would
  // be asking the wrong question — only the stamps changed, and only they are
  // re-read.
  //
  // Re-read from the panel, in fact, which reloaded them as part of the same
  // action and hands the list over rather than leaving us to ask for it again.
  // The second GET was not just wasted: between the two, the panel's copy and
  // this one disagreed about a collection the owner had just changed. `null` is
  // the panel saying its own read failed, which is the only case left that has
  // to go to the server.
  function handleSharingChanged(next: ProCollectionStamp[] | null) {
    if (next) applyStamps(next);
    else void loadStamps();
  }

  // The shared-holdings panel connected this instance to an organization or
  // left one. `pro` came from /auth at page load, so it now describes a pairing
  // that no longer exists — and the thing that reads it is the new-collection
  // dialog, which sets an engagement boundary that is deliberately permanent.
  // Getting it wrong is therefore not a stale label: pair, create the very
  // collection the pairing was done for, and it is silently kept local forever.
  //
  // Re-read rather than patch the flag from what the panel just did. /auth is
  // the one place that decides what the owner is told about Pro, and a second
  // copy of that decision here is the drift the block was narrowed to avoid.
  async function handlePairingChanged() {
    const a = await api.getAuth().catch(() => null);
    // A failed re-read leaves the last known snapshot in place. The panel has
    // already reported its own outcome, and blanking `pro` here would close the
    // shared-holdings panel out from under the operator who just used it.
    if (a) handleAuthRefreshed(a);
  }

  // A title click in any view re-fetches /auth to decide PDF access; fold that
  // fresh snapshot back into app state so the whole UI (share column, tooltips,
  // file badges) reflects a mid-session Open Library or token change.
  function handleAuthRefreshed(a: AuthStatus) {
    setIsAdmin(a.admin);
    setTokenRequired(a.token_required);
    setLibraryOpen(a.library_open);
    // Part of the same snapshot since /auth started gating it on the caller: a
    // token change that this fold-back exists to catch changes whether the Pro
    // block was sent at all.
    setPro(a.pro ?? null);
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
      // PubMed hands over at most the first 9,999 records per query, so a broad
      // topic's feed is genuinely incomplete. Said plainly rather than left to
      // be inferred from a count nobody has a reference point for — the feed
      // would otherwise look complete, and only the user can decide whether to
      // narrow the topic or watch fewer journals.
      const capped = res.results.filter((r) => r.truncated);
      for (const r of capped) {
        msg += ` “${r.topicName}” matches more papers than PubMed will return — kept the ${r.found.toLocaleString()} most recent, skipped ${r.truncated!.toLocaleString()}. Narrow the topic or watch fewer journals for full coverage.`;
      }
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
  //
  // "All collections" is guarded on the list the same way the branches either
  // side of it are guarded on their entity: it is a scope *over* the
  // collections, so with none there is nothing for it to select. Unguarded it
  // was the one selection that could survive its subject disappearing —
  // loadCollections deliberately doesn't re-validate the way loadTopics does,
  // since deletion is handled where it happens, so a collection removed in
  // another tab or by another user on a shared instance left `source` non-null
  // with an empty library. That skips the no-source screen entirely and renders
  // a collection view with no collection: an empty state telling you to click
  // Add files, beneath a picker that has already withheld the entry you would
  // have had to click to get there.
  const source: PaperSource | null = inInterests
    ? activeTopic && { topic: activeTopic.id }
    : inLibrary
      ? activeCollectionId === "all"
        ? collections.length > 0
          ? { allCollections: true }
          : null
        : activeCollection && { collection: activeCollection.id }
      : activeFolder && { folder: activeFolder.id };
  const showViewControls = !showSettings && source != null;
  const sourceId = source ? sourceKey(source) : null;
  // The token every cached fetch under this source is stamped with; a bump to
  // any other source leaves it alone, so the views keep painting from cache.
  const reloadToken = sourceId ? tokenFor(reloads, sourceId) : 0;

  // A new source starts at the top, the same rule its filters follow (see
  // usePaperFilters). Nothing carries the offset over deliberately — scroll
  // belongs to the document, not to the view, so it simply outlives the swap
  // underneath it. That leaves it pointing at rows the new view hasn't
  // rendered, since both views re-paginate from their first chunk on every
  // switch; the browser then clamps it to the new list's height, so where you
  // land is decided by how long the *previous* list happened to be.
  //
  // Keyed on the source rather than the mode so picking another topic within
  // Interests resets too — same carried-over offset, same non-reason — and on
  // showSettings, which swaps the list for a page of a completely different
  // height while the source underneath it stays put. The gear can't reach that
  // state from a scrolled page (it rides in the non-sticky header, so you're
  // back at the top by the time you click it), but the picker's "Add topic…"
  // row can: it sits in the sticky bar, clickable however deep you've scrolled.
  //
  // Not keyed on reloadToken. That bumps on in-place data changes too — see
  // removeBookmark, which invalidates the very folder you're reading — and
  // yanking the page to the top mid-read is worse than the offset it'd fix.
  //
  // Only *swaps* reset, never the first view we settle on: reloading a scrolled
  // page has the browser restore that offset, and a scroll to top on arrival
  // would throw it away. Arriving is two renders — sourceId is null until the
  // sources load, then becomes the active one — so it can't be recognised by
  // mount alone; record the first view seen and reset only once it changes.
  // Comparing keys rather than counting runs also absorbs StrictMode's
  // double-invoke, which repeats the effect with the deps untouched.
  //
  // Before paint, not after: the new view is already committed and the browser
  // has already clamped the carried-over offset to it, so a passive effect
  // would show one frame of the wrong place before the jump — a shorter version
  // of the glitch this exists to remove.
  const lastView = useRef<string | null>(null);
  useLayoutEffect(() => {
    // Nothing to land on yet: no source, and not the standalone Settings page.
    if (sourceId == null && !showSettings) return;
    const view = `${sourceId}|${showSettings}|${viewMode}`;
    if (lastView.current === view) return;
    const arriving = lastView.current == null;
    lastView.current = view;
    if (!arriving) window.scrollTo(0, 0);
  }, [sourceId, showSettings, viewMode]);

  // The truly-empty message differs by source: topics fill from PubMed,
  // collections fill from uploads, folders from papers the user saves. Viewers
  // get a variant that doesn't point at controls they don't have.
  const emptyState = !isAdmin ? (
    <>No papers here yet. The site owner hasn’t added any.</>
  ) : inInterests ? (
    <>
      No papers yet. Add journals &amp; topics in{" "}
      <strong><SettingsIcon size={14} className="inline-icon" aria-hidden /> Settings</strong>, then
      click “Check for new papers”.
    </>
  ) : inLibrary ? (
    <>
      No papers yet. Click{" "}
      <strong><FilePlus size={14} className="inline-icon" aria-hidden /> Add files</strong> to upload
      PDFs — select as many as you like, a whole folder's worth at a time. The app scans each PDF for
      its PubMed ID and pulls in the title, authors, journal, year, and citation count.
    </>
  ) : (
    <>No papers in this folder yet.</>
  );

  // Same idea one level up: nothing is selected because this workspace has no
  // entries at all.
  const noSourceState = !isAdmin ? (
    <>
      Nothing here yet. The site owner hasn’t added any{" "}
      {inInterests ? "topics" : inLibrary ? "collections" : "bookmark folders"}.
    </>
  ) : inInterests ? (
    <>
      No topics yet. Open{" "}
      <strong><SettingsIcon size={14} className="inline-icon" aria-hidden /> Settings</strong> to add
      a journal and a MeSH topic to watch, or switch to{" "}
      <strong><LibraryIcon size={14} className="inline-icon" aria-hidden /> {MODES.papers.label}</strong>{" "}
      to import your own PDFs.
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
      // The same handler the collection chrome uses: removing papers changes
      // the collection's counts and its file list exactly as an upload does.
      onCollectionChanged={handleCollectionChanged}
    />
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo"><Dna aria-hidden /></span>
          <h1>Scibrarian</h1>
          <span className="version">v{__APP_VERSION__}</span>
          {/* A real page reload, not a refetch. What it is reached for is a view
              in a state the app's own cache invalidation didn't fix, and asking
              the same code that produced that state to repair it is the thing
              that already didn't work.

              In the brand rather than beside the gear for two reasons. The
              desktop build is a plain BrowserWindow with no address bar, so
              there is no reload anywhere on screen and the accelerator is the
              only way out — for a window that looks like an app, not a browser
              tab, that is not a discoverable one. And the header's controls are
              stand-ins until the first load resolves, while this has to work
              during exactly that load: a first paint that never finishes is
              what it is for. */}
          <button
            className="reload-btn"
            onClick={() => window.location.reload()}
            aria-label="Refresh"
            title="Refresh"
          >
            <RotateCw size={15} aria-hidden />
          </button>
        </div>
        <div className="header-actions">
          {!loaded ? (
            // Reserve the controls' space during the first load so they don't
            // pop in and shift the header once data arrives. Stand-ins built
            // from the real controls, not bars sized by eye: the row is
            // right-aligned, so anything narrower than what lands slides every
            // control along it — which is what two guessed bars did here.
            //
            // What's reserved is what the load is about to produce. The view
            // switch: `source` is null until then, but the load lands in the
            // first workspace that holds anything (see the effect above), so it
            // appears for everyone past an empty app. "Check references" is
            // ungated and always does. The icon buttons are one or two — a
            // viewer's padlock, or an admin's gear beside the one that locks
            // again — and a stored token is what tells the two apart, which is
            // readable here and now rather than after /api/auth answers.
            //
            // The token is a fair proxy because a refused one doesn't survive:
            // the bootstrap above drops it the first time the server answers
            // that it isn't admin, so a token still here means the last real
            // answer was yes. A revoked token still costs one wrong guess, on
            // the load that discovers it.
            <>
              <ViewSwitcherSkeleton />
              <button className="have-btn" disabled aria-hidden="true">
                <SkeletonBar w={16} h={16} />
                <span className="have-btn-label">
                  <SkeletonBar h={14}>{HAVE_CHECK_TITLE}</SkeletonBar>
                </span>
              </button>
              {Array.from({ length: getAdminToken() != null ? 2 : 1 }).map((_, i) => (
                <button key={i} className="gear-btn" disabled aria-hidden="true">
                  <SkeletonBar w={16} h={16} />
                </button>
              ))}
            </>
          ) : (
            <>
              {showViewControls && (
                <ViewSwitcher viewMode={viewMode} onChange={setViewMode} />
              )}
              {/* Not gated on isAdmin: checking whether the library already
                  holds a paper is a read, and on a shared instance it's the
                  viewers — the writers told to check before requesting a
                  purchase — who need it most.

                  Named after its *input*, not its scope. "Do I have this?" read
                  as a lookup, which is what the search box does, so the two
                  looked like the same thing offered twice; since search can now
                  answer an identifier and span every collection, that reading
                  was actively wrong. What this does and search can't is take a
                  list and answer it line by line. Deliberately not "search
                  everything" — after the all-collections source that describes
                  the search box too. */}
              <button
                className={`have-btn ${checkingHave ? "active" : ""}`}
                onClick={() => setCheckingHave(true)}
                title="Check a reference list against the library — paste PMIDs, DOIs, PubMed links or citations, one per line"
              >
                <SearchCheck size={16} aria-hidden />
                <span className="have-btn-label">{HAVE_CHECK_TITLE}</span>
              </button>
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
          sharedCollectionIds={sharedCollectionIds}
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
            pro={pro}
            onDataChanged={loadTopics}
            onPairingChanged={handlePairingChanged}
            onSharingChanged={handleSharingChanged}
            onPapersRemoved={(count) => {
              setStatus(`Removed ${count} paper${count === 1 ? "" : "s"} from Interests.`);
              // A journal or topic removal sweeps papers out of any number of
              // topics at once, so nothing narrower than everything is safe.
              reloadEverything();
            }}
          />
        ) : !source ? (
          <div className="empty">{noSourceState}</div>
        ) : inInterests ? (
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
            // "all" carries no collection, which is what empties the management
            // chrome inside the view — see CollectionView's collectionId.
            collectionId={typeof activeCollectionId === "number" ? activeCollectionId : null}
            isAdmin={isAdmin}
            // Nothing for the all-collections view: the badge is a statement
            // about one collection, and the aggregate is a mix of them.
            stamp={
              typeof activeCollectionId === "number"
                ? (stampByCollection.get(activeCollectionId) ?? null)
                : null
            }
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
              // The folder's bookmarks are deleted with it (the rows cascade),
              // so the map of what's saved has to come back from the server
              // too. Reloading only the folder list leaves every paper it held
              // showing a filled icon and "Saved in 1 folder" for a folder that
              // no longer exists — a claim nothing in the UI can then undo.
              const [, fs] = await Promise.all([loadBookmarks(), loadFolders()]);
              setActiveFolderId(fs.length > 0 ? fs[0].id : null);
              reloadEverything();
            }}
          >
            {module}
          </BookmarkFolderView>
        )}
      </main>

      <HaveCheck
        open={checkingHave}
        onClose={() => setCheckingHave(false)}
        access={access}
        // The check is the one modal that writes to the library from outside
        // the Library view: a copy pulled from the organization lands in a
        // collection, and its destination picker can create one. Without this
        // the shell never hears about either — a collection made here was
        // missing from the sidebar and the source picker for the rest of the
        // session, and a paper copied into the collection already on screen
        // didn't appear in it.
        onChanged={handleCollectionChanged}
      />

      <PromptDialog
        open={namingFolder}
        title="New folder"
        placeholder="Folder name"
        maxLength={MAX_NAME_CHARS}
        submitLabel="Create"
        onSubmit={createFolder}
        onCancel={() => setNamingFolder(false)}
      />

      <PromptDialog
        open={namingCollection}
        title="New collection"
        placeholder="Collection name"
        maxLength={MAX_NAME_CHARS}
        submitLabel="Create"
        // Pre-filled, never a gate. The common case — this really is work for
        // the organization you are paired to — costs nothing, and the exception
        // is one click at the only moment the writer knows the answer. Absent
        // entirely when unpaired, which is why such collections stay local
        // permanently rather than being adopted on a later pairing.
        option={
          pro?.is_paired
            ? {
                label: "Share with your organization",
                hint: " Papers you add here are copied to its library — the PDF and its PubMed ID, nothing else.",
                defaultChecked: true,
              }
            : undefined
        }
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
