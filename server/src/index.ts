import fs from "node:fs";
import express from "express";
import cors from "cors";
import { CLIENT_DIST, PORT } from "./config.js";
import "./db.js"; // initialize schema + seed on startup
import { api } from "./routes.js";
import { startScheduler } from "./poller.js";
import { ensureCatalogLoaded } from "./journal-catalog.js";

const app = express();
// The API can browse the local filesystem and launch the PDF viewer, so it must
// only be reachable from this machine: bind to loopback (below) and refuse
// cross-origin browser requests from anything but localhost.
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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[server] API listening on http://localhost:${PORT}`);
  startScheduler();
  void ensureCatalogLoaded(); // warm the journal catalog in the background
});
