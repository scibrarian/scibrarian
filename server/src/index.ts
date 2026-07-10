import fs from "node:fs";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { ADMIN_TOKEN, CLIENT_DIST, HOST, HOST_IS_LOOPBACK, PORT } from "./config.js";
import "./db.js"; // initialize schema + seed on startup
import { api } from "./routes.js";
import { startScheduler } from "./poller.js";
import { ensureCatalogLoaded } from "./journal-catalog.js";
import { errMessage } from "./util.js";

const app = express();
// Mutations are gated by the admin-token middleware in routes.ts; this CORS
// allowlist is only defense-in-depth against stray cross-origin pages on this
// machine. Both dev (Vite proxies /api) and prod (Express serves the client)
// are same-origin, so remote viewers never need CORS headers.
app.use(cors({ origin: [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] }));
app.use(express.json());

app.use("/api", api);

// In production, serve the built client. In dev, Vite serves the UI separately.
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (_req, res) => {
    res.sendFile(`${CLIENT_DIST}/index.html`);
  });
}

// Uncaught route errors land here as the JSON shape the client's error handling
// expects, instead of Express's default HTML error page. Errors that carry an
// HTTP status (e.g. body-parser's 400s) keep it; anything else is a 500.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const status = (err as { status?: unknown } | null)?.status;
  console.warn(`[server] ${errMessage(err)}`);
  res.status(typeof status === "number" ? status : 500).json({ error: errMessage(err) });
});

// Without a token every request can mutate data, so exposing the server beyond
// this machine in that state would let anyone who can reach it change anything.
if (!HOST_IS_LOOPBACK && !ADMIN_TOKEN) {
  console.error(
    `[server] Refusing to start: HOST=${HOST} is reachable by other machines but ` +
      `ADMIN_TOKEN is not set. Set ADMIN_TOKEN in server/.env so only you can modify data.`
  );
  process.exit(1);
}

app.listen(PORT, HOST, () => {
  const url = HOST_IS_LOOPBACK ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`[server] API listening on ${url}`);
  if (ADMIN_TOKEN) console.log("[server] Admin mode on: mutations require ADMIN_TOKEN");
  startScheduler();
  void ensureCatalogLoaded(); // warm the journal catalog in the background
});
