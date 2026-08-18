import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project root is one level up from server/src -> server -> project root
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// The desktop (Electron) build sets this. It pins the server to loopback with
// no admin token, so the sharing features — which only make sense for a server
// other machines can reach — are inert; the UI reads it to say so plainly
// instead of pointing at a server/.env that a packaged app doesn't have.
export const IS_DESKTOP = process.env.SCIBRARIAN_DESKTOP === "1";

// PORT=0 means "let the OS assign a free port" — the desktop build relies on it
// so a packaged app can't collide with a dev server or a second instance. A
// plain `Number(...) || 3001` would swallow that 0, so parse explicitly and
// keep the default for unset/garbage values.
function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) return 3001;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 3001;
}

export const PORT = parsePort(process.env.PORT);

// The port actually bound. PORT above is only the *request*: with PORT=0 the
// real one is chosen by the OS at bind time, and it is the only one anything can
// connect to. Anything that prints, shares, or links to this server's address
// must read this rather than PORT, or a PORT=0 deployment advertises
// "http://192.168.1.20:0". start() fills it in; the fallback covers the window
// before the bind resolves, when the answer is not yet knowable anyway.
let bound: number | null = null;

export function setBoundPort(port: number): void {
  bound = port;
}

export function boundPort(): number {
  return bound ?? PORT;
}

// Host/interface to bind. Default loopback = this machine only. Anything else
// (0.0.0.0, a LAN/Tailscale IP) requires ADMIN_TOKEN — enforced in index.ts.
export const HOST = process.env.HOST || "127.0.0.1";

export const HOST_IS_LOOPBACK =
  HOST === "localhost" || HOST === "::1" || HOST.startsWith("127.");

// When set, all non-GET API requests must present it: `X-Admin-Token` from the
// browser client, or `Authorization: Bearer <token>` from a script or curl.
// isAdminRequest in routes.ts accepts either, and records why the browser can't
// use Authorization — behind an edge login that header is already taken.
// When empty, the app behaves as before: single user, no auth (loopback only).
// Trimmed so a pasted trailing newline in .env doesn't break every unlock.
// A comma in it is refused at startup (see index.ts): repeated headers of one
// name arrive comma-joined, and the split that recovers ours from that cannot
// reassemble a token containing the separator.
export const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

export const DB_PATH = path.isAbsolute(process.env.DB_PATH || "")
  ? (process.env.DB_PATH as string)
  : path.join(PROJECT_ROOT, process.env.DB_PATH || "data/app.db");

// Content-addressed PDF storage (uploads are hashed and kept here). The tmp dir
// sits beside the blobs so the post-hash rename stays on one filesystem.
export const BLOBS_DIR = path.isAbsolute(process.env.BLOBS_DIR || "")
  ? (process.env.BLOBS_DIR as string)
  : path.join(PROJECT_ROOT, process.env.BLOBS_DIR || "data/blobs");

export const UPLOAD_TMP_DIR = path.join(path.dirname(BLOBS_DIR), "tmp-uploads");

// Fallback poll schedule (daily at 06:00) — used to seed the setting and as
// the last resort when the saved cron expression is invalid.
export const DEFAULT_POLL_CRON = "0 6 * * *";

// First-run values for the settings table. These settings are managed in the
// Settings UI only — the settings table is the single source of truth, and
// .env plays no part (deploy-level config like PORT/HOST stays above).
export const SETTING_DEFAULTS = {
  ncbi_api_key: "",
  ncbi_email: "",
  poll_cron: DEFAULT_POLL_CRON,
  poll_enabled: "0",
  // Owner's opt-in: viewers may download stored PDFs without a share link.
  // Deliberately a UI setting (not env): the instance owner, not whoever
  // deploys the server, must be the one making that call.
  library_open: "0",
};

// Path to the built client (used in production / `npm start`). Overridable
// because PROJECT_ROOT is only meaningful when the server runs from a checkout:
// the desktop build points this at the client bundle inside the app's
// resources, where nothing sits at the expected offset from server/src.
export const CLIENT_DIST = process.env.CLIENT_DIST
  ? path.resolve(process.env.CLIENT_DIST)
  : path.join(PROJECT_ROOT, "client", "dist");
