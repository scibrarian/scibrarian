import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project root is one level up from server/src -> server -> project root
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

export const PORT = Number(process.env.PORT) || 3001;

// Host/interface to bind. Default loopback = this machine only. Anything else
// (0.0.0.0, a LAN/Tailscale IP) requires ADMIN_TOKEN — enforced in index.ts.
export const HOST = process.env.HOST || "127.0.0.1";

export const HOST_IS_LOOPBACK =
  HOST === "localhost" || HOST === "::1" || HOST.startsWith("127.");

// When set, all non-GET API requests require `Authorization: Bearer <token>`.
// When empty, the app behaves as before: single user, no auth (loopback only).
// Trimmed so a pasted trailing newline in .env doesn't break every unlock.
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
};

// Path to the built client (used in production / `npm start`)
export const CLIENT_DIST = path.join(PROJECT_ROOT, "client", "dist");
