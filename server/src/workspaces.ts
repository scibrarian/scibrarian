// Workspaces: one freelancer, several agencies, one database each.
//
// A medical writer straddles engagements, and the whole Pro design turns on
// keeping them apart — collection_org stamps a shelf for the organisation it
// was created under, and nothing is ever claimed retroactively. That boundary
// is per-collection, which is the right grain for *sync* and the wrong one for
// everything else: one library still means one topic list, one set of MeSH
// filters, one search box spanning every client's material at once, and one
// paired master. A workspace is the coarse boundary those need. Separate
// database, separate blob store, separate pairing.
//
// **Desktop only, and by construction.** It takes two variables, both set by
// the Electron main process and by nothing else: SCIBRARIAN_WORKSPACES_ROOT,
// which says where the libraries live, and SCIBRARIAN_DESKTOP, which is that
// process saying what it is. A Docker or `npm start` deployment sets neither,
// reads DB_PATH exactly as it always did, and gets "off" from every function
// here. A hosted instance is one organisation's server; the problem this solves
// does not exist there.
//
// The conjunction is what makes "by construction" true rather than merely
// customary. The root alone is an undocumented variable but a reachable one,
// and an operator who set it on a hosted box would switch on a feature whose
// every assumption — one local user, a loopback bind, no admin token — is false
// there.
//
// Nothing in this module imports config.ts or db.ts, and the root is read from
// the environment lazily rather than at module scope. Both are load-bearing:
// electron/main.mjs imports this bundle *before* it has decided which database
// to point the server at — that decision is what it imports this to make — and
// a module that read env at evaluation, or that pulled in config.ts, would
// freeze the answer before the question was asked.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// The one import from outside node: builtins. A bare constant, so it costs this
// module nothing of the independence the note above rests on.
import { MAX_NAME_CHARS } from "../../shared/limits.js";

/** One workspace as the registry records it. */
export interface WorkspaceRecord {
  id: string;
  name: string;
  created_at: string;
}

interface Registry {
  /** The workspace the app opens into. Always an id present in `workspaces`. */
  active: string;
  workspaces: WorkspaceRecord[];
}

/**
 * Where workspaces live, or "" when this build has none.
 *
 * Read on every call rather than cached, because the one caller that matters
 * sets it moments before the first read (see the module note above).
 */
export function workspacesRoot(): string {
  return process.env.SCIBRARIAN_WORKSPACES_ROOT?.trim() || "";
}

/**
 * Whether this build has workspaces at all — see the note above for why it
 * takes both variables rather than just the root.
 *
 * Read raw from the environment rather than through config.ts's IS_DESKTOP,
 * which is the identical value. Importing config.ts here would freeze the
 * answer before the question is asked, which is the ordering this whole module
 * is arranged around.
 */
export function workspacesEnabled(): boolean {
  return workspacesRoot() !== "" && process.env.SCIBRARIAN_DESKTOP === "1";
}

// ---------- the on-disk layout ----------
//
// Decided now, before there is anything to migrate, because the shape of it is
// what keeps the *next* change possible.
//
//   <root>/workspaces.json          the registry below
//   <root>/workspaces/<id>/app.db   one library
//   <root>/workspaces/<id>/blobs/   its stored PDFs
//
// The rule the layout encodes: **a workspace directory holds only what is
// genuinely that workspace's.** Nothing shared is ever written inside one.
//
// That matters because most of a database is not the workspace's at all. On a
// current install app.db is ~46 MB, of which the user's own material — articles,
// collections, bookmarks — is a rounding error: the rest is 38,009 journal
// catalog rows, 31,110 MeSH descriptors and 267,012 entry terms, all of it
// identical in every workspace and all of it re-downloaded from NLM and
// OpenAlex per workspace on its own refresh cycle. The fix is to lift those
// tables into a reference database attached read-only and shared by every
// workspace, and the same goes for the two settings a person should not have to
// type twice (ncbi_api_key, ncbi_email).
//
// Those are deliberately not built yet. What is built is the room for them:
//
//   <root>/reference.db             journal_catalog + mesh_* (reserved)
//   <root>/settings.db              the machine-wide settings (reserved)
//
// Both sit *beside* the workspaces rather than inside any one of them, so
// splitting the tables out later moves data between databases and changes no
// path. The layout this replaces — one self-contained directory per workspace,
// the obvious first design — would have made the same split a relocation of
// everything on disk, which is the reason to decide this before shipping rather
// than after.
//
// Restart-based switching already blunts the worst of the duplication: exactly
// one workspace is open at a time, so there is never more than one poller or
// one catalog refresh running, and the cost is spread over switches rather than
// paid concurrently. It is the total traffic to NLM that stays wrong.

function registryPath(): string {
  return path.join(workspacesRoot(), "workspaces.json");
}

function workspacesDir(): string {
  return path.join(workspacesRoot(), "workspaces");
}

export function workspaceDir(id: string): string {
  return path.join(workspacesDir(), id);
}

export function workspaceDbPath(id: string): string {
  return path.join(workspaceDir(id), "app.db");
}

export function workspaceBlobsDir(id: string): string {
  return path.join(workspaceDir(id), "blobs");
}

/**
 * Whether an id is safe to use as the directory name it becomes.
 *
 * Every id this app mints is a randomUUID, so in the ordinary course this is
 * never false. It is checked anyway because an id read back out of the registry
 * is joined into a path by all four functions above and then handed to a
 * recursive remove in deleteWorkspace, and the registry is a JSON file sitting
 * in a directory the user can open. An id of "../.." resolves above the root,
 * and the membership check deleteWorkspace makes first would pass — the bad id
 * really is in the list.
 *
 * A path-shape check rather than a UUID one on purpose: too strict a rule drops
 * a workspace whose directory is real, and a dropped workspace is a library
 * nothing opens again, which is the loss this whole module is arranged around.
 */
function isWorkspaceId(id: string): boolean {
  if (!id || id === "." || id === "..") return false;
  return !/[\\/\0]/.test(id) && !path.isAbsolute(id);
}

// ---------- the registry ----------

/**
 * The registry, or null when there isn't a readable one.
 *
 * A file that exists but doesn't parse reads as absent on purpose. The caller
 * that matters is ensureActive(), which then rebuilds — and a half-written
 * registry is recoverable that way, where throwing at launch leaves an app that
 * cannot start and a user with no way to fix it. What is never lost is a
 * library: the directories are named by id, which is what lets rebuild() adopt
 * whatever is on disk rather than mint a fresh workspace beside it.
 */
function readRegistry(): Registry | null {
  if (!workspacesEnabled()) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath(), "utf8");
  } catch {
    return null; // no registry yet — the first-run path
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Registry>;
    const workspaces = (Array.isArray(parsed.workspaces) ? parsed.workspaces : []).flatMap((w) =>
      w && typeof w.id === "string" && isWorkspaceId(w.id) && typeof w.name === "string"
        ? [{ id: w.id, name: w.name, created_at: String(w.created_at ?? "") }]
        : []
    );
    if (workspaces.length === 0) return null;
    // An `active` naming nothing is repaired rather than honoured: it is one
    // hand-edit or one interrupted write away, and the first workspace is a
    // better answer than refusing to open.
    const active = workspaces.some((w) => w.id === parsed.active)
      ? (parsed.active as string)
      : workspaces[0].id;
    return { active, workspaces };
  } catch {
    return null;
  }
}

/**
 * Replace the registry atomically.
 *
 * Write-then-rename, because the alternative is a truncated file: this is
 * rewritten on every switch, and a switch is immediately followed by the
 * process quitting. A crash mid-write would otherwise leave the launch path
 * with a file it can't parse, and although readRegistry survives that (see
 * above), surviving it by rebuilding is not the same as never seeing it.
 */
function writeRegistry(reg: Registry): void {
  const dir = workspacesRoot();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.workspaces.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, registryPath());
}

/**
 * A name that can be told apart from the others, or a message saying why not.
 *
 * Case-insensitively unique, for the reason two collections sharing a name are
 * refused: the picker is the only place a workspace is identified, and two
 * rows reading "Acme" in it are a coin flip over which agency's library you are
 * about to open.
 */
function validateName(name: string, existing: WorkspaceRecord[], exceptId = ""): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A workspace needs a name.";
  if (trimmed.length > MAX_NAME_CHARS) {
    return `A workspace name can be at most ${MAX_NAME_CHARS} characters.`;
  }
  const clash = existing.some(
    (w) => w.id !== exceptId && w.name.toLowerCase() === trimmed.toLowerCase()
  );
  return clash ? `There is already a workspace called "${trimmed}".` : null;
}

/**
 * The workspace this launch should open, creating the registry if there isn't
 * one. Called once, by the Electron main process, before the server is imported.
 *
 * Throws when workspaces are off — an embedder asking this question has already
 * decided it is a desktop build, and answering with a fabricated default would
 * point a hosted server at a path nothing else knows about.
 */
export function ensureActiveWorkspace(): WorkspaceRecord {
  if (!workspacesEnabled()) {
    throw new Error(
      "Workspaces are desktop-only: SCIBRARIAN_WORKSPACES_ROOT and " +
        "SCIBRARIAN_DESKTOP=1 must both be set."
    );
  }
  const existing = readRegistry();
  // readRegistry guarantees the active id names one of these, but the lookup is
  // what the type needs and the fallback costs a line.
  const active = existing?.workspaces.find((w) => w.id === existing.active) ?? rebuild();
  ensureWorkspaceDirs(active.id);
  adoptLegacyLibrary(active.id);
  return active;
}

/**
 * The workspace to open when the registry could not say — a first launch, a
 * damaged file, or a read that failed for a moment.
 *
 * Adopting the directories already on disk is the whole of the difference
 * between a damaged registry costing a name and costing a library. This used to
 * go straight to firstRun(), which minted a fresh workspace and wrote it over
 * the top: every real library stayed exactly where it was, in a directory
 * nothing would ever name again. The registry is one small file, rewritten on
 * every switch and read on a machine with an antivirus scanner in the way. It
 * is not a thing to make a person's papers depend on.
 *
 * The oldest becomes active, because which one *was* is the single fact the
 * file held that the directories cannot give back.
 */
function rebuild(): WorkspaceRecord {
  const found = workspacesOnDisk();
  if (found.length === 0) return firstRun();
  writeRegistry({ active: found[0].id, workspaces: found });
  return found[0];
}

/**
 * Every library on disk, oldest first.
 *
 * Registry order is creation order — it is the order the picker draws — so the
 * rebuild has to reconstruct it: readdir order is the filesystem's and means
 * nothing. The directory's own birth time is the only record of it left.
 *
 * The names are not recoverable at all; they lived in the file. Renaming them
 * afterwards is the whole cost of a recovery that keeps every library, which is
 * the trade this is here to make.
 */
function workspacesOnDisk(): WorkspaceRecord[] {
  let ids: string[];
  try {
    ids = fs
      .readdirSync(workspacesDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && isWorkspaceId(e.name))
      .map((e) => e.name);
  } catch {
    return []; // no workspaces directory: nothing has ever run here
  }
  const born = new Map(ids.map((id) => [id, birthTime(id)]));
  // Two created in the same millisecond are ordered by id, which is arbitrary
  // but at least the same on every launch — a picker that reshuffled itself
  // between them would be worse.
  ids.sort((a, b) => born.get(a)! - born.get(b)! || a.localeCompare(b));
  return ids.map((id, i) => ({
    id,
    name: `Recovered workspace ${i + 1}`,
    created_at: new Date(born.get(id)!).toISOString(),
  }));
}

function birthTime(id: string): number {
  try {
    const stat = fs.statSync(workspaceDir(id));
    // birthtime is 0 on the filesystems that don't record one; mtime is the
    // better of the two wrong answers there.
    return stat.birthtimeMs || stat.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Build the registry a machine that has never had one should have had.
 *
 * Nothing is adopted here. adoptLegacyLibrary below is what brings a
 * pre-workspaces library in, and it runs after this has written the registry —
 * see the note there for why that order is the one that survives a move that
 * fails halfway.
 */
function firstRun(): WorkspaceRecord {
  const ws: WorkspaceRecord = {
    id: randomUUID(),
    // The same name whether or not anything is about to be adopted, because it
    // is true of both: on a fresh install there is nothing yet to say whose
    // library this is, and on an adopted one this is everything the person had
    // from before there was more than one place to put it. An agency's name is
    // something they add when they create the second workspace and the
    // distinction starts to mean something.
    name: "Default workspace",
    created_at: new Date().toISOString(),
  };
  ensureWorkspaceDirs(ws.id);
  writeRegistry({ active: ws.id, workspaces: [ws] });
  return ws;
}

/**
 * Move a library that predates workspaces into the workspace that will open it.
 *
 * Every desktop copy so far has kept its library at <root>/app.db with its PDFs
 * in <root>/blobs, and those are someone's papers — the app cannot start a
 * fresh empty workspace beside them and leave them stranded at a path nothing
 * will ever open again.
 *
 * A move, not a copy: a 46 MB database duplicated on first launch is a second
 * copy that will drift, and rename() within one directory tree is atomic and
 * costs nothing. The -wal and -shm go with it — a WAL database separated from
 * its write-ahead log loses whatever had not been checkpointed, which on a
 * library closed by a window close is the last session's work.
 *
 * This is not a schema migration and does not become one. Nothing here reads or
 * writes a table; the database is opaque, and what moves is a file.
 *
 * **Runs on every launch, and skips whatever is already in place.** It used to
 * run once, inside first-run, before the registry had been written — so an
 * EPERM on the second file, which on Windows is an ordinary thing for a scanner
 * or an indexer to cause, left the database moved, no registry written, and the
 * next launch minting a fresh workspace beside a library it could no longer
 * see. Now the failure is loud and the launch after it finishes the job.
 *
 * Nothing can open a database in between: the embedder calls this before it has
 * set DB_PATH, so a throw here means the server is never imported and no empty
 * database is created over the top of the one still waiting at the root.
 */
function adoptLegacyLibrary(id: string): void {
  const root = workspacesRoot();
  const legacyDb = path.join(root, "app.db");
  const legacyBlobs = path.join(root, "blobs");
  if (!fs.existsSync(legacyDb) && !fs.existsSync(legacyBlobs)) return;

  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${legacyDb}${suffix}`;
    const to = `${workspaceDbPath(id)}${suffix}`;
    // A destination that already exists is a database this workspace is already
    // using. Left alone, and the source left where it is: two databases is a
    // question for a person, not one to answer by overwriting either of them.
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
  }
  if (fs.existsSync(legacyBlobs)) adoptBlobs(legacyBlobs, workspaceBlobsDir(id));
  // tmp-uploads is removed rather than moved. Its contents are dead uploads by
  // definition — blobstore.ts empties it on every startup — so carrying them
  // into the new layout would carry rubbish. Removed rather than simply left,
  // because config.ts derives UPLOAD_TMP_DIR from BLOBS_DIR: once the blobs
  // move under the workspace, the directory blobstore.ts empties on startup is
  // the one beside them, and this one would be emptied by nothing, ever.
  fs.rmSync(path.join(root, "tmp-uploads"), { recursive: true, force: true });
}

/**
 * Move the stored PDFs across, merging rather than replacing.
 *
 * The whole directory in one rename is the fast path, and what a clean adoption
 * takes. It is guarded on the destination being empty because this also runs as
 * the resumption of an interrupted adoption, where the destination already
 * holds whatever the first attempt managed to move — and the rmSync that clears
 * the way, correct while it could only ever be aimed at the empty directory
 * ensureWorkspaceDirs had just made, would there delete a library's PDFs.
 *
 * Merging skips a file the destination already has rather than overwriting it,
 * which is safe rather than merely convenient: blobs are named by content hash,
 * so two files with one name are the same bytes.
 */
function adoptBlobs(from: string, to: string): void {
  if (!fs.existsSync(to) || fs.readdirSync(to).length === 0) {
    // rename onto an existing directory fails on every platform, so take the
    // empty one out of the way first.
    if (fs.existsSync(to)) fs.rmdirSync(to);
    fs.renameSync(from, to);
    return;
  }
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name);
    if (fs.existsSync(path.join(to, name))) fs.rmSync(source, { recursive: true, force: true });
    else fs.renameSync(source, path.join(to, name));
  }
  // Only once it is genuinely empty: an entry that could not be moved is not
  // one this should be the thing to delete.
  if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
}

function ensureWorkspaceDirs(id: string): void {
  fs.mkdirSync(workspaceBlobsDir(id), { recursive: true });
}

/** Every workspace, registry order (creation order). Empty when the feature is off. */
export function listWorkspaces(): WorkspaceRecord[] {
  return readRegistry()?.workspaces ?? [];
}

/** The workspace this process is running in, or null off-desktop. */
export function activeWorkspace(): WorkspaceRecord | null {
  const reg = readRegistry();
  if (!reg) return null;
  return reg.workspaces.find((w) => w.id === reg.active) ?? null;
}

/**
 * The workspaces this process is *not* running in — the ones whose databases
 * are closed, and the only ones the holdings union has anything to read.
 */
export function otherWorkspaces(): WorkspaceRecord[] {
  const reg = readRegistry();
  if (!reg) return [];
  return reg.workspaces.filter((w) => w.id !== reg.active);
}

/** A refusal message, or null when the name is usable. */
export function checkWorkspaceName(name: string, exceptId = ""): string | null {
  return validateName(name, listWorkspaces(), exceptId);
}

/**
 * Add a workspace. It starts empty; the schema is created the first time a
 * process opens it, which is the next launch after switching to it.
 */
export function createWorkspace(name: string): WorkspaceRecord {
  const reg = readRegistry();
  if (!reg) throw new Error("No workspace registry.");
  const ws: WorkspaceRecord = {
    id: randomUUID(),
    name: name.trim(),
    created_at: new Date().toISOString(),
  };
  ensureWorkspaceDirs(ws.id);
  writeRegistry({ ...reg, workspaces: [...reg.workspaces, ws] });
  return ws;
}

export function renameWorkspace(id: string, name: string): WorkspaceRecord | null {
  const reg = readRegistry();
  if (!reg) return null;
  const ws = reg.workspaces.find((w) => w.id === id);
  if (!ws) return null;
  const renamed = { ...ws, name: name.trim() };
  writeRegistry({
    ...reg,
    workspaces: reg.workspaces.map((w) => (w.id === id ? renamed : w)),
  });
  return renamed;
}

/**
 * Destroy a workspace and everything in it. Irreversible.
 *
 * Refuses the active one, which is not a policy so much as a fact: its database
 * is open in this process, Windows will not unlink a file that is, and there
 * would be nothing for the app to be looking at afterwards. It is also what
 * guarantees a workspace always survives — the active one cannot be the thing
 * being deleted, so the list can never empty.
 *
 * **The registry entry goes first, then the files.** If the removal fails part
 * way, an orphaned directory is invisible and costs disk; a registry row
 * pointing at a gutted library is offered in the picker, read by the holdings
 * union, and switched into. Of the two halves this can be left in, that is the
 * one to leave.
 */
export function deleteWorkspace(id: string): "ok" | "active" | "unknown" {
  const reg = readRegistry();
  if (!reg || !reg.workspaces.some((w) => w.id === id)) return "unknown";
  if (reg.active === id) return "active";
  writeRegistry({ ...reg, workspaces: reg.workspaces.filter((w) => w.id !== id) });
  try {
    // force, so a directory already gone — a half-finished earlier attempt — is
    // not an error on the run that finishes the job.
    fs.rmSync(workspaceDir(id), { recursive: true, force: true });
  } catch (err) {
    // Reported, never thrown, and this is the other half of the ordering above.
    // The registry has already been written: the workspace is gone as far as
    // anything can see, and answering the caller with a failure would leave a
    // picker showing a row that the next read will not produce, beside a
    // message saying the delete did not happen. Windows raises this for
    // ordinary reasons — a PDF open in a viewer, a scanner on the blob store —
    // and what survives is bytes nothing references.
    const why = err instanceof Error ? err.message : String(err);
    console.warn(`[workspaces] deleted ${id}, but its directory remains: ${why}`);
  }
  return "ok";
}

/**
 * Point the next launch at a different workspace.
 *
 * Takes effect on restart and never before — see the note on onRestartRequested
 * for why the live handle is not swapped instead. Returns false for an id the
 * registry doesn't know, so a stale client can't leave `active` naming nothing.
 */
export function setActiveWorkspace(id: string): boolean {
  const reg = readRegistry();
  if (!reg || !reg.workspaces.some((w) => w.id === id)) return false;
  ensureWorkspaceDirs(id);
  writeRegistry({ ...reg, active: id });
  return true;
}

// ---------- restarting into the chosen workspace ----------

/**
 * How the app restarts itself, registered by the embedder at start().
 *
 * Switching is a relaunch rather than a live swap, and that is the whole design
 * rather than an unfinished version of one. `db` in db.ts is a module-scope
 * DatabaseSync that the poller's cron job, the Pro push sweep, warmCitations
 * and every in-flight request hold by reference; closing it under them fails
 * each of those separately, at whatever moment they next touch it, and none of
 * those failures looks like "the workspace changed". A relaunch reaches the
 * same state through the path that is already exercised on every launch.
 *
 * Registered through start() and not imported directly, because this module is
 * bundled twice for the desktop build — once inside bundle/server.mjs, once as
 * bundle/workspaces.mjs for the main process to read the registry before the
 * server exists — and the two are separate module instances. Everything else
 * here keeps its state in the file on disk and so doesn't care; this is the one
 * piece of state that lives in memory, and it must be set on the copy the
 * routes will call.
 */
let restart: (() => void) | null = null;

export function onRestartRequested(fn: (() => void) | undefined): void {
  restart = fn ?? null;
}

/**
 * Whether anything is listening — asked *before* the restart, so the switch
 * route can say in its response whether the app is about to disappear or
 * whether the choice merely takes effect next time. Nothing registers a handler
 * except the desktop shell, so this is false for a browser pointed at the
 * server directly.
 */
export function canRestart(): boolean {
  return restart != null;
}

/** True when a restart was actually asked for; false when nothing can. */
export function requestRestart(): boolean {
  if (!restart) return false;
  restart();
  return true;
}
