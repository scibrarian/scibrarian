import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import express, { NextFunction, Request, Response, Router } from "express";
import cors from "cors";
import { ADMIN_TOKEN, CLIENT_DIST, HOST, HOST_IS_LOOPBACK, PORT, setBoundPort } from "./config.js";
import { db, holdingsByPmids } from "./db.js"; // importing also initializes schema + seed on startup
import { api, isAdminRequest } from "./routes.js";
import { loadPro } from "./pro-hooks.js";
import {
  ensureCollection,
  heldFile,
  matchedFilesIn,
  readFileBytes,
  storePulledFile,
} from "./pro-storage.js";
import { startScheduler } from "./poller.js";
import { refreshCatalogIfStale } from "./journal-catalog.js";
import { ensureMeshLoaded } from "./mesh-catalog.js";
import { backfillArticleMesh } from "./mesh-index.js";
import { errMessage, GENERIC_CLIENT_ERROR, GENERIC_SERVER_ERROR } from "./util.js";
import { MAX_BULK_BOOKMARK_BYTES } from "../../shared/limits.js";

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

// Refuse cross-site mutations outright, before any body is parsed.
//
// CORS is not this. CORS stops a page *reading* a response; it never stops the
// request from happening. A form-encoded POST is a "simple request", so it is
// sent with no preflight, executes, and only the reply is withheld — which is
// no comfort when the side effect was the point.
//
// Most of the API is protected from that by accident rather than by design: its
// mutations need a JSON body, a form POST cannot carry one, and asking for
// `application/json` forces the preflight that CORS then blocks. Any route
// taking everything it needs from the URL falls straight through that gap.
// `POST /api/refresh` did, and so did the Pro pull before it moved its PMID into
// a body — the far worse case, because the side effect there is copying
// licensed articles onto disk.
//
// Fetch Metadata closes the class instead of the instance. Browsers always send
// Sec-Fetch-Site and script cannot forge it; non-browser callers — the Vite dev
// proxy, curl, and the spoke→master requests in the Pro module — do not send it
// at all. So the rule is *if present, it must be same-origin*: absent is not a
// bypass, it is a caller that was never subject to a browser's ambient
// credentials in the first place.
//
// Registered before the body parsers so a refused request is never parsed, and
// before both /api mounts so it covers the Pro routes that deliberately sit
// outside the admin gate.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

app.use("/api", (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const site = req.get("sec-fetch-site");
  if (site == null || site === "same-origin") return next();
  res.status(403).json({ error: "Cross-site requests are not allowed." });
});

// The bulk bookmark save posts one PMID per paper in the filtered set, which is
// thousands of them by design — past body-parser's 100kb default at around nine
// thousand. It gets its own parser rather than a raised global limit, so no
// other endpoint starts accepting megabyte bodies. This has to be mounted
// *before* the general parser: the first parser to run marks the body as read
// and the other then skips it, so ordering these the other way round would
// leave the big saves being rejected by the 100kb one before ever reaching the
// route. The count is capped in the handler, which is what reports it.
app.use("/api/bookmark-folders/:id/papers", express.json({ limit: MAX_BULK_BOOKMARK_BYTES }));
app.use(express.json());

// Pro-tier routes, mounted ahead of /api and deliberately *outside* the api
// router.
//
// The admin gate in routes.ts authenticates the owner of this instance. A
// paired node is not that: it is a peer with one narrow permission, and its
// pairing token must never be accepted as an admin token. Mounting here keeps
// the two authentications from ever meeting — /api/pro never reaches the admin
// middleware, and the Pro module carries its own. Mounting inside `api` would
// put every Pro POST behind the admin gate, where a spoke would be rejected
// before its own auth ever ran, and the tempting fix is to widen the gate.
//
// The router is created empty and filled in during start(): route registration
// order is fixed at mount time, so waiting for the async module load to mount
// it would place it after the /api 404 below and every Pro request would 404.
// An express Router is mutable after mounting, which sidesteps that. In a free
// build it stays empty, falls through, and the 404 answers — which is correct.
const proRouter = Router();
app.use("/api/pro", proRouter);

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
  const generic = status >= 400 && status < 500 ? GENERIC_CLIENT_ERROR : GENERIC_SERVER_ERROR;
  res.status(status).json({ error: expose ? errMessage(err) : generic });
});

// Bind and start the background work, resolving once the port is known.
//
// The port is read back off the listening socket rather than echoed from
// config: PORT=0 asks the OS for a free port, which the desktop build relies on
// (see config.ts), and only the socket knows which one it got. Exported so an
// embedder — the Electron main process — can start the server in-process and
// learn where to point its window. Rejects instead of exiting so a failed bind
// is the caller's to report; the CLI path below turns that back into an exit.
export async function start(): Promise<{ port: number; url: string }> {
  // Without a token every request can mutate data, so exposing the server beyond
  // this machine in that state would let anyone who can reach it change anything.
  if (!HOST_IS_LOOPBACK && !ADMIN_TOKEN) {
    throw new Error(
      `Refusing to start: HOST=${HOST} is reachable by other machines but ` +
        `ADMIN_TOKEN is not set. Set ADMIN_TOKEN in server/.env so only you can modify data.`
    );
  }

  // Before the bind, so no request can arrive at a half-registered Pro router.
  // A module that fails to load is fatal rather than a silent downgrade to the
  // free tier — see loadPro for why that distinction matters.
  const pro = await loadPro({
    db,
    isAdminRequest,
    // file_id is the whole test — see ProContext.heldPmids for why it is this
    // and not the presence of an articles row.
    heldPmids: (pmids) =>
      new Set(holdingsByPmids(pmids).flatMap((r) => (r.file_id != null ? [r.pmid] : []))),
    heldFile,
    ensureCollection,
    matchedFilesIn,
    readFileBytes,
    storePulledFile,
  });
  if (pro) {
    proRouter.use(pro.routes());
    console.log(`[server] Pro module ${pro.version} loaded`);
  }

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(PORT, HOST);
    // Whichever fires first wins; the loser is detached so a later socket error
    // can't settle an already-settled promise.
    s.once("listening", () => {
      s.removeListener("error", reject);
      // Something must stay attached in its place: an 'error' event with no
      // listener is rethrown by EventEmitter and takes the process down. Here
      // that would be long after this promise settled and after main()'s startup
      // try/catch returned, so in the desktop build it would kill the window and
      // the in-process server together, silently. A server-level error after a
      // successful bind (an accept failure, a socket-level fault) doesn't mean
      // the listener is finished, so log it and keep serving.
      s.on("error", (err) => console.error(`[server] ${errMessage(err)}`));
      resolve(s);
    });
    s.once("error", reject);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  // Publish it before anything can serve a request: the sharing panel builds
  // its URLs from this, and PORT is the wrong answer whenever PORT=0.
  setBoundPort(port);
  const url = HOST_IS_LOOPBACK ? `http://localhost:${port}` : `http://${HOST}:${port}`;
  console.log(`[server] API listening on ${url}`);
  if (ADMIN_TOKEN) console.log("[server] Admin mode on: mutations require ADMIN_TOKEN");
  startScheduler();
  void refreshCatalogIfStale(); // warm (or refresh a stale) journal catalog in the background
  void ensureMeshLoaded(); // warm the MeSH descriptor list in the background
  void backfillArticleMesh(); // file stored papers under their MeSH headings
  return { port, url };
}

// Start automatically only when this file is the process entry (`tsx
// src/index.ts`, the Dockerfile's CMD). When Electron imports it for `start()`
// the check fails and nothing binds until it asks — importing a module must not
// have the side effect of taking a port.
//
// Both sides are canonicalized through realpath, not just resolved. Node follows
// symlinks when it loads an ES module, so import.meta.url is always the real
// path on disk, while argv[1] is whatever the caller typed. Any checkout reached
// through a link — macOS's /tmp, which is really /private/tmp, a CI workspace
// symlink, a Windows junction, a Docker bind mount through one — would compare
// unequal on resolve alone, and the process would exit 0 having printed nothing
// and bound no port: a failure wearing success's clothes. Compared
// case-insensitively on Windows, which hands back the same path with an
// inconsistent drive-letter case.
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (p: string) => {
    let resolved: string;
    try {
      resolved = fs.realpathSync(p);
    } catch {
      resolved = path.resolve(p); // nothing at that path: compare it as given
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(entry) === normalize(fileURLToPath(import.meta.url));
}

if (isProcessEntry()) {
  start().catch((err: unknown) => {
    console.error(`[server] ${errMessage(err)}`);
    process.exit(1);
  });
}
