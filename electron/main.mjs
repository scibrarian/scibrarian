// Desktop shell for Scibrarian.
//
// There is no separate backend process: the same Express server the Docker and
// `npm start` deployments run is imported and started inside the Electron main
// process, bound to loopback, and the window simply loads it over HTTP. The
// renderer is the unmodified web client — it talks to relative /api paths and is
// served by that same origin, so it needs no desktop-specific build.
//
// That works because the server has no native dependencies: node:sqlite is built
// into Electron's Node runtime, verified to support the WAL and foreign-key
// pragmas server/src/db.ts sets on startup.
import { app, BrowserWindow, dialog, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
// CommonJS, and with no named exports Node's lexer can detect — so the obvious
// `import { autoUpdater } from "electron-updater"` fails at link time with
// `Named export 'autoUpdater' not found`, before a line of this file runs and
// reading like a broken install rather than an interop rule. Take the default
// export and destructure it. Same family of trap as ELECTRON_RUN_AS_NODE.
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

const here = path.dirname(fileURLToPath(import.meta.url));

// Two copies would open the same SQLite file and, worse, run two pollers
// against NCBI's per-key rate limit. Second launch hands focus to the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** Where the built React client lives, packaged or straight from the checkout. */
function clientDist() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "client")
    : path.join(here, "..", "client", "dist");
}

/**
 * Point the server at this machine's per-user data directory and pin it to
 * loopback, before the module is imported — config.ts reads process.env once at
 * evaluation, so a dynamic import after this is what makes the ordering safe.
 *
 * The defaults it would otherwise use are all relative to the repo root, which
 * in a packaged app is a read-only directory inside the bundle.
 */
function configureServer() {
  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });

  // dotenv (config.ts) never overwrites a variable that is already set, so
  // every assignment here also shuts out a stray .env sitting next to the
  // executable — including one that would flip the app off loopback.
  process.env.SCIBRARIAN_DESKTOP = "1";
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0"; // OS-assigned: never collide with a dev server or another app
  process.env.ADMIN_TOKEN = ""; // single local user; also keeps share-link minting disabled
  process.env.DB_PATH = path.join(userData, "app.db");
  process.env.BLOBS_DIR = path.join(userData, "blobs");
  process.env.CLIENT_DIST = clientDist();
}

/**
 * Keep the window on the app's own origin and hand everything else to the
 * user's real browser. Without this, every PubMed and doi.org link in the UI
 * would open a bare Electron window with no address bar or browser chrome —
 * which is both a poor way to read a paper and a poor thing to point at the
 * open web.
 */
function applyNavigationPolicy(contents, origin) {
  const isAppUrl = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false; // unparseable, or a non-http scheme we want nothing to do with
    }
  };
  const openExternally = (url) => {
    // Only ever hand http(s) to the OS. shell.openExternal on an arbitrary
    // scheme is a way to launch things that are not browsers.
    if (/^https?:$/i.test(new URL(url).protocol)) void shell.openExternal(url);
  };

  contents.setWindowOpenHandler(({ url }) => {
    // openPaper() opens a blank tab synchronously inside the click handler and
    // navigates it once it knows whether the destination is a stored PDF or
    // PubMed. Allowing it keeps that flow intact; will-navigate below still
    // judges wherever it ends up going.
    if (url === "about:blank" || isAppUrl(url)) {
      return {
        action: "allow",
        // A stored PDF opens here, in Chromium's viewer. Inherit nothing:
        // state these explicitly so a child window can never be the weak one.
        overrideBrowserWindowOptions: {
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    try {
      openExternally(url);
    } catch {
      /* unparseable url: drop it */
    }
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    try {
      openExternally(url);
    } catch {
      /* unparseable url: drop it */
    }
    // A window that has never shown anything of its own has nothing to fall back
    // to once its one navigation goes to the browser instead — leaving it up
    // strands a blank, chrome-less, address-bar-less window whose only use is
    // being closed. That is exactly the shape of the popup openPaper() opens
    // synchronously in the click handler before it knows the destination.
    //
    // The main window is never blank here: will-navigate isn't emitted for
    // loadURL, so by the time any navigation reaches this handler it is already
    // on the app's origin and returned above.
    const current = contents.getURL();
    if (current === "" || current === "about:blank") contents.close();
  });

  // Nothing in the client uses <webview>; refuse to be the first.
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

/**
 * Set once the server is listening. Also the "app is ready to show a window"
 * flag: until it has a value there is nothing for a window to load, and main()
 * is still on its way to opening the first one.
 */
let appOrigin = null;

/** Open the main window. Called again on macOS if the user closed the last one. */
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false, // revealed on ready-to-show, so the app never flashes a blank frame
    backgroundColor: "#111111",
    title: "Scibrarian",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  return win.loadURL(appOrigin);
}

/**
 * Bring the app back to the front, re-creating the window if there isn't one.
 *
 * On macOS the process outlives its last window (see window-all-closed), so the
 * Dock icon, a Finder relaunch, and `open -a` all arrive here with zero windows
 * open — without the re-create the app would be running and unreachable.
 */
function focusOrCreateWindow() {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  if (!appOrigin) return; // still starting: main() is about to open the first window
  createWindow().catch((err) => {
    dialog.showErrorBox("Scibrarian could not open a window", String(err?.stack || err));
  });
}

/**
 * Check for a new version, download it in the background, and install it the
 * next time the app quits.
 *
 * Switched off wherever there is no feed to check, which would throw rather than
 * no-op if it ran anyway: an unpackaged checkout (`npm run desktop`) has no
 * app-update.yml, and neither has a `--dir` pack on macOS or Windows — the
 * system listener that writes the file returns early unless a dmg/zip or an
 * NSIS target is in the build (PublishManager's onAfterPack). Linux is not
 * guarded there, so a `--dir` pack on Linux does carry the file and does reach
 * the check below — and nothing follows from that: AppImageUpdater overrides
 * isUpdaterActive, finds no APPIMAGE in the environment, warns once and returns
 * false, so checkForUpdates resolves null before any request is made. No guard
 * of ours is needed for it.
 *
 * That file is the packaged form of the `publish` config — electron-builder
 * writes it into resources only when a publish target exists — so its presence
 * is the honest answer to "does this installer have anywhere to update from",
 * and its contents are what decide which tier's releases this copy follows.
 * Reading the file rather than keeping a tier flag here means there is only one
 * such fact; electron-builder.config.cjs asserts at pack time that it names the
 * right one, since a Pro copy following the free feed would replace itself with
 * the free build and lose pairing without reporting anything.
 */
function startUpdateChecks() {
  if (!app.isPackaged) return;
  if (!fs.existsSync(path.join(process.resourcesPath, "app-update.yml"))) return;

  // Attached before the check and not optional: AppUpdater is an EventEmitter,
  // and emitting "error" with no listener throws out of whatever is running. A
  // laptop that is offline at launch is the ordinary case here, not a fault, so
  // this stays a log line and never reaches a dialog.
  autoUpdater.on("error", (err) => console.error("[updates]", err?.stack || err));

  // ...AndNotify rather than a bare check: it downloads in the background and
  // shows an OS notification once the update is staged, which then applies on
  // the next quit. Nothing interrupts a reading session and the renderer needs
  // no UI for it.
  autoUpdater
    .checkForUpdatesAndNotify()
    .catch((err) => console.error("[updates]", err?.stack || err));
}

async function main() {
  await app.whenReady();
  configureServer();

  let port;
  try {
    // Imported only now, so it reads the environment configureServer() just set.
    const { start } = await import("./bundle/server.mjs");
    ({ port } = await start());
  } catch (err) {
    dialog.showErrorBox(
      "Scibrarian could not start",
      `The local server failed to start.\n\n${err?.stack || err}`
    );
    app.exit(1);
    return;
  }

  // 127.0.0.1, not localhost: the server binds IPv4 only, while "localhost"
  // can resolve to ::1 first and fail to connect.
  const origin = `http://127.0.0.1:${port}`;

  // Covers child windows (the PDF viewer) as well as the main one.
  app.on("web-contents-created", (_event, contents) => applyNavigationPolicy(contents, origin));

  appOrigin = origin;
  await createWindow();

  // After the window, not before: this reaches the network, and nothing about
  // it should sit between launch and the app being usable.
  startUpdateChecks();
}

app.on("second-instance", focusOrCreateWindow);

// macOS: the Dock icon, and reopening an already-running app from Finder.
app.on("activate", focusOrCreateWindow);

// Standard macOS behaviour: closing the last window doesn't quit the app. The
// activate handler above is what makes that survivable — it is the only way
// back to a window once the last one is gone.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

main().catch((err) => {
  dialog.showErrorBox("Scibrarian could not start", String(err?.stack || err));
  app.exit(1);
});
