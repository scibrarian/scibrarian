import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project root is one level up from server/src -> server -> project root
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

export const PORT = Number(process.env.PORT) || 3001;

export const DB_PATH = path.isAbsolute(process.env.DB_PATH || "")
  ? (process.env.DB_PATH as string)
  : path.join(PROJECT_ROOT, process.env.DB_PATH || "data/app.db");

// Used to seed editable settings on first run; afterwards the values in the
// settings table win (so they can be changed in the UI).
export const ENV_DEFAULTS = {
  ncbi_api_key: process.env.NCBI_API_KEY || "",
  ncbi_email: process.env.NCBI_EMAIL || "everyonecast@gmail.com",
  poll_cron: process.env.POLL_CRON || "0 6 * * *", // daily at 06:00
};

// Path to the built client (used in production / `npm start`)
export const CLIENT_DIST = path.join(PROJECT_ROOT, "client", "dist");
