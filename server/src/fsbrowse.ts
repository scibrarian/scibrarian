import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Server-side filesystem browsing for the collection folder picker. The server
// runs on the user's own machine, so this is how the web UI gets a native-like
// folder dialog: list drives/directories, filter files to PDFs. Read-only —
// no file contents are ever served.

export interface FsPlace {
  label: string;
  path: string;
}

export interface FsRootsResponse {
  roots: FsPlace[];
  home: string;
  shortcuts: FsPlace[];
}

export interface FsListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  files: { name: string; path: string; size: number; mtime: string }[];
}

// Errors carry an HTTP status so the route can answer 400/403/404 cleanly.
export class FsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function listRoots(): Promise<FsRootsResponse> {
  const home = os.homedir();
  const roots: FsPlace[] = [];
  if (process.platform === "win32") {
    // Probe drive letters in parallel; an absent drive just rejects its stat.
    const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    const probes = await Promise.allSettled(letters.map((l) => fs.promises.stat(`${l}:\\`)));
    probes.forEach((p, i) => {
      if (p.status === "fulfilled") {
        roots.push({ label: `${letters[i]}:`, path: `${letters[i]}:\\` });
      }
    });
  } else {
    roots.push({ label: "/", path: "/" });
  }
  const shortcuts: FsPlace[] = [{ label: "Home", path: home }];
  for (const name of ["Desktop", "Documents", "Downloads"]) {
    const p = path.join(home, name);
    if (fs.existsSync(p)) shortcuts.push({ label: name, path: p });
  }
  return { roots, home, shortcuts };
}

// Hidden/system noise we never show at any level.
function skipDir(name: string): boolean {
  return (
    name.startsWith(".") || name.startsWith("$") || name === "System Volume Information"
  );
}

export function isPdf(name: string): boolean {
  return /\.pdf$/i.test(name);
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export async function listDir(raw: string): Promise<FsListing> {
  if (!raw || !path.isAbsolute(raw)) {
    throw new FsError(400, "An absolute path is required.");
  }
  const p = path.resolve(raw);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(p, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new FsError(404, "That folder no longer exists.");
    }
    if (code === "EPERM" || code === "EACCES") {
      throw new FsError(403, "Windows won't allow reading that folder.");
    }
    throw err;
  }

  const dirs: FsListing["dirs"] = [];
  const pdfNames: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && !skipDir(e.name)) {
      dirs.push({ name: e.name, path: path.join(p, e.name) });
    } else if (e.isFile() && isPdf(e.name)) {
      pdfNames.push(e.name);
    }
  }

  // Stat the PDFs for size/mtime; a file vanishing mid-listing is just skipped.
  const stats = await Promise.allSettled(
    pdfNames.map((n) => fs.promises.stat(path.join(p, n)))
  );
  const files: FsListing["files"] = [];
  stats.forEach((s, i) => {
    if (s.status === "fulfilled") {
      files.push({
        name: pdfNames[i],
        path: path.join(p, pdfNames[i]),
        size: s.value.size,
        mtime: s.value.mtime.toISOString(),
      });
    }
  });

  dirs.sort(byName);
  files.sort(byName);
  const parent = path.dirname(p);
  return { path: p, parent: parent === p ? null : parent, dirs, files };
}

// Expand a mix of directory and file paths into the PDF files they contain.
// Directories are scanned for *.pdf (recursively when asked); unreadable
// subdirectories are skipped rather than failing the whole import.
export async function collectPdfs(
  paths: string[],
  recursive: boolean
): Promise<{ path: string; name: string }[]> {
  const out = new Map<string, { path: string; name: string }>();

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !skipDir(e.name)) {
        if (recursive && depth < 12) await walk(full, depth + 1);
      } else if (e.isFile() && isPdf(e.name)) {
        out.set(full, { path: full, name: e.name });
      }
    }
  }

  for (const raw of paths) {
    if (!raw || !path.isAbsolute(raw)) {
      throw new FsError(400, `Not an absolute path: ${raw}`);
    }
    const p = path.resolve(raw);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(p);
    } catch {
      continue; // vanished between picking and importing
    }
    if (st.isDirectory()) {
      await walk(p, 0);
    } else if (st.isFile() && isPdf(p)) {
      out.set(p, { path: p, name: path.basename(p) });
    }
  }
  return [...out.values()];
}
