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
// **Desktop only, and by construction.** SCIBRARIAN_WORKSPACES_ROOT is set by
// the Electron main process and by nothing else, so a Docker or `npm start`
// deployment reads DB_PATH exactly as it always did and every function here
// answers "off". A hosted instance is one organisation's server; the problem
// this solves does not exist there.
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

export function workspacesEnabled(): boolean {
  return workspacesRoot() !== "";
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

// ---------- the registry ----------

/**
 * The registry, or null when there isn't a readable one.
 *
 * A file that exists but doesn't parse reads as absent on purpose. The caller
 * that matters is ensureActive(), which then builds a fresh one — and a
 * half-written registry is recoverable that way, where throwing at launch
 * leaves an app that cannot start and a user with no way to fix it. What is
 * never lost is a library: the directories are named by id and the ids are in
 * the file, so a rebuilt registry re-adopts whatever it finds on disk.
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
      w && typeof w.id === "string" && typeof w.name === "string"
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
    throw new Error("SCIBRARIAN_WORKSPACES_ROOT is not set; workspaces are desktop-only.");
  }
  const existing = readRegistry();
  if (existing) {
    const active = existing.workspaces.find((w) => w.id === existing.active);
    // readRegistry guarantees this, but the lookup is what the type needs and
    // the fallback costs a line.
    if (active) {
      ensureWorkspaceDirs(active.id);
      return active;
    }
  }
  return firstRun();
}

/**
 * Build the registry an install that predates workspaces should have had.
 *
 * The interesting half is adoption. Every desktop copy so far has kept its
 * library at <root>/app.db with its PDFs in <root>/blobs, and those are
 * someone's papers — the app cannot start a fresh empty workspace beside them
 * and leave them stranded at a path nothing will ever open again. So the files
 * are *moved* into the first workspace's directory and the registry points at
 * them.
 *
 * A move, not a copy: a 46 MB database duplicated on first launch is a second
 * copy that will drift, and rename() within one directory tree is atomic and
 * costs nothing. The -wal and -shm go with it — a WAL database separated from
 * its write-ahead log loses whatever had not been checkpointed, which on a
 * library closed by a window close is the last session's work.
 *
 * This is not a schema migration and does not become one. Nothing here reads or
 * writes a table; the database is opaque, and what moves is a file.
 */
function firstRun(): WorkspaceRecord {
  const root = workspacesRoot();
  const legacyDb = path.join(root, "app.db");
  const legacyBlobs = path.join(root, "blobs");
  const adopting = fs.existsSync(legacyDb);

  const ws: WorkspaceRecord = {
    id: randomUUID(),
    // The same name whether or not anything was adopted, because it is true of
    // both: on a fresh install there is nothing yet to say whose library this
    // is, and on an adopted one this is everything the person had from before
    // there was more than one place to put it. An agency's name is something
    // they add when they create the second workspace and the distinction starts
    // to mean something.
    name: "Default workspace",
    created_at: new Date().toISOString(),
  };
  ensureWorkspaceDirs(ws.id);

  if (adopting) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = `${legacyDb}${suffix}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${workspaceDbPath(ws.id)}${suffix}`);
    }
    if (fs.existsSync(legacyBlobs)) {
      // The blob directory is created by ensureWorkspaceDirs, and rename onto an
      // existing directory fails on every platform — so take the empty one out
      // of the way first. Only ever the one this function just made.
      fs.rmSync(workspaceBlobsDir(ws.id), { recursive: true, force: true });
      fs.renameSync(legacyBlobs, workspaceBlobsDir(ws.id));
    }
    // tmp-uploads is deliberately left behind. blobstore.ts empties it on every
    // startup, so its contents are dead uploads by definition and moving them
    // would carry rubbish into the new layout.
  }

  writeRegistry({ active: ws.id, workspaces: [ws] });
  return ws;
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
  // force, so a directory already gone — a half-finished earlier attempt — is
  // not an error on the run that finishes the job.
  fs.rmSync(workspaceDir(id), { recursive: true, force: true });
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
