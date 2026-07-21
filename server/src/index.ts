import fs from "node:fs";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { ADMIN_TOKEN, CLIENT_DIST, HOST, HOST_IS_LOOPBACK, PORT } from "./config.js";
import "./db.js"; // initialize schema + seed on startup
import { api } from "./routes.js";
import { startScheduler } from "./poller.js";
import { refreshCatalogIfStale } from "./journal-catalog.js";
import { ensureMeshLoaded } from "./mesh-catalog.js";
import { errMessage, GENERIC_SERVER_ERROR } from "./util.js";

const app = express();

// Content-Security-Policy. The prod build is a single same-origin bundle +
// stylesheet with no inline <script>, so script-src stays 'self' — no
// 'unsafe-eval' (the lone Function("return this") in a dependency is a
// short-circuited global-detection fallback that never runs in a browser) and no
// 'unsafe-inline'. Dynamic inline style attributes (React style props, Radix
// positioning) do need 'unsafe-inline' in style-src. All data lives at
// same-origin /api, so connect-src falls back to default-src 'self'; there are
// no external fonts/images, web workers, or frames. Deliberately no
// upgrade-insecure-requests — the LAN/localhost deployments run over plain HTTP,
// and forcing HTTPS there would break them.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Baseline security headers on every response (SPA, API, and streamed PDF blobs
// alike). nosniff stops a browser from MIME-sniffing a response — notably a
// same-origin uploaded PDF — into HTML it would execute in our origin, where the
// admin token lives in localStorage. DENY blocks framing, so the token-authed UI
// can't be clickjacked (frame-ancestors in the CSP is the modern equivalent;
// both are set for coverage across browsers). Registered before every route so
// it also covers the static client and the sendFile'd PDFs.
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// Mutations are gated by the admin-token middleware in routes.ts; this CORS
// allowlist is only defense-in-depth against stray cross-origin pages on this
// machine. Both dev (Vite proxies /api) and prod (Express serves the client)
// are same-origin, so remote viewers never need CORS headers.
app.use(cors({ origin: [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] }));
app.use(express.json());

app.use("/api", api);

// Anything under /api the router didn't match must fail as JSON here — without
// this, unknown /api GETs fall through to the SPA fallback below and return
// index.html with a 200, which hides typos and removed endpoints from callers.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

// In production, serve the built client. In dev, Vite serves the UI separately.
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (_req, res) => {
    res.sendFile(`${CLIENT_DIST}/index.html`);
  });
}

// Uncaught route errors land here as the JSON shape the client's error handling
// expects, instead of Express's default HTML error page. The raw message is
// always logged for the operator, but only returned to the client when it was
// explicitly marked safe to expose — client-facing 4xx (body-parser's parse
// errors, our httpError()s). Everything else gets a generic body, so internal
// detail (fs paths, upstream/library strings, stack messages) never leaks in 5xx.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  const e = err as { status?: unknown; statusCode?: unknown; expose?: unknown } | null;
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.statusCode === "number"
        ? e.statusCode
        : 500;
  console.warn(`[server] ${errMessage(err)}`);
  // http-errors (body-parser) sets expose=true on its safe 4xx; treat any 4xx as
  // exposable unless explicitly flagged otherwise, plus anything we deliberately
  // marked via httpError().
  const expose = e?.expose === true || (e?.expose == null && status >= 400 && status < 500);
  res.status(status).json({ error: expose ? errMessage(err) : GENERIC_SERVER_ERROR });
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
  void refreshCatalogIfStale(); // warm (or refresh a stale) journal catalog in the background
  void ensureMeshLoaded(); // warm the MeSH descriptor list in the background
});
