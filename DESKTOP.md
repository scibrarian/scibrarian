# Desktop builds

Scibrarian also ships as a desktop app: an [Electron](https://www.electronjs.org/)
window wrapped around the same server the web and Docker deployments run.

This document covers building and distributing it. To just *run* it, see
[README](README.md#desktop-app).

## How it fits together

There is no separate backend process. `electron/main.mjs` imports the ordinary
Express server (`server/src/index.ts`, compiled to one file by esbuild), starts
it on `127.0.0.1` with an OS-assigned port, and points a `BrowserWindow` at it.
The renderer is the unmodified React client — it calls relative `/api` paths and
is served from that same origin, so there is no desktop-specific UI build.

That works because the server has no native dependencies: `node:sqlite` is built
into Electron's Node runtime, so there is nothing to compile or rebuild per
platform.

Desktop mode differs from the server in exactly three ways, all set in
`main.mjs` before the server is imported:

| | Desktop | Server |
|---|---|---|
| Bind address | `127.0.0.1`, always | `HOST` (default loopback) |
| Port | OS-assigned | `PORT` (default 3001) |
| `ADMIN_TOKEN` | forced empty | optional |
| Database & PDFs | per-user app data dir | `DB_PATH` / `BLOBS_DIR` |

Because a desktop install is loopback-only with no token, **sharing is
unavailable by design** — share links can't be minted, and Settings → Sharing
says so instead of offering options that cannot work. Sharing a library means
running the server build; see [DEPLOY.md](DEPLOY.md).

### Where your data lives

The app writes its database and stored PDFs to the OS per-user app data
directory, not into the installation folder:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Scibrarian` |
| macOS | `~/Library/Application Support/Scibrarian` |
| Linux | `~/.config/Scibrarian` |

Uninstalling does not remove it. That directory is the thing to back up, and
deleting it resets the app to a first run.

### Scheduled polling on a machine that sleeps

A cron schedule only fires while the app is running, so a desktop app that is
closed most of the day would miss every scheduled poll. When scheduled polling
is enabled, a start that finds the schedule was missed runs that poll a few
seconds later. It respects the same **Scheduled polling** setting as the timer:
turn that off and startups poll nothing.

This is not desktop-specific — the server does it too, since a stopped container
or a rebooted host misses schedules the same way. It just matters most here,
where the process is closed more often than it is open. "Missed" is measured
against your own cron expression, so a weekly schedule stays weekly rather than
catching up every day.

## Building

```bash
npm install
npm run desktop:pack     # unpacked app only, for testing — no installer
npm run desktop:dist     # installers for the current platform
```

Both build the React client first, then the server bundle, then package.
Output lands in `electron/dist/`.

Use the root scripts rather than `npm run pack -w desktop` directly: the
workspace scripts do not build the client, and the build fails with a pointer to
this if you skip it.

### What each platform produces

| Platform | Target | Artifact |
|---|---|---|
| Windows | NSIS | `Scibrarian Setup <version>.exe` |
| macOS | dmg | `Scibrarian-<version>.dmg` (arm64 builds add `-arm64`) |
| Linux | AppImage | `Scibrarian-<version>.AppImage` |

**You can only build for the platform you are on.** electron-builder can cross-
compile some targets, but macOS signing and notarization require macOS. Use a
CI matrix (`windows-latest`, `macos-latest`, `ubuntu-latest`) to produce all
three.

### Where the version comes from

The release number lives in the **root `package.json`** and nowhere else.
`electron/electron-builder.config.cjs` reads it from there and injects it via
`extraMetadata`, which is what names the artifacts, stamps the executable, and
feeds `latest.yml` for auto-update. Bumping the root version is the whole
release step; the Docker tags already work the same way.

The `version` field in `electron/package.json` is a deliberate placeholder
(`0.0.0-managed-by-root`) and is never used. It exists only because npm requires
a version on every workspace member. If you ever see that string on a built
artifact, the config was not applied.

The config is passed explicitly (`--config electron-builder.config.cjs`) rather
than discovered: electron-builder looks for `electron-builder.*`, not
`electron-builder.config.*`, so relying on discovery silently produces a build
with **no config at all** — no bundled client, no icons, default everything —
and still exits 0.

### Architecture

electron-builder targets the host architecture by default, so an Apple Silicon
Mac produces an **arm64-only** dmg that will not run on Intel Macs. Widening it
means getting an extra flag through to electron-builder, which the root script
does forward:

```bash
npm run desktop:dist -- -- --universal     # one fat binary, roughly double the size
npm run desktop:dist -- -- --x64 --arm64   # two separate artifacts
```

**Both `--` are load-bearing.** The first ends npm's own arguments, the second
is appended to the script and ends `npm run dist -w desktop`'s, so the flag
lands in electron-builder's argv. Write only one and npm swallows the flag: the
build still runs, still exits 0, and still produces a host-architecture-only
artifact.

You can call the workspace script directly instead — `npm run dist -w desktop --
--universal` — but then building the client is your job, per
[Building](#building). On a clean checkout `electron/build.mjs` will stop you
with `The built client is missing from …`; on a tree that still has an old
`client/dist` nothing stops you, and the stale UI is what gets packaged.

## Signing

Unsigned builds work on the machine that made them and are fine for testing.
Distributing them is a different matter, and the two platforms fail differently.

Nothing in `electron/electron-builder.config.cjs` needs to change when you have
certificates — electron-builder reads them from the environment.

### Windows

Without a signature, every download shows a SmartScreen warning that the user
must click past ("More info" → "Run anyway"). Nothing is blocked outright.

Since the 2023 CA/Browser Forum rules, newly issued OV certificates require a
hardware token or a cloud HSM, so the old "point `CSC_LINK` at a `.pfx`" flow
only works for certificates issued before that. Current options:

- **Azure Trusted Signing** — roughly $10/month, cloud-based, no hardware. Add
  an `azureSignOptions` block to `win:` in the config and set `AZURE_TENANT_ID`,
  `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`. Requires identity validation;
  individuals need about three years of verifiable operating history.
- **EV certificate on a hardware token** — expensive, but carries SmartScreen
  reputation immediately.
- **A pre-2023 OV certificate** — `CSC_LINK` (path or base64 of the `.pfx`) plus
  `CSC_KEY_PASSWORD`. Reputation still accrues over the first few hundred
  downloads.

### macOS

Gatekeeper is stricter than SmartScreen: an unsigned app downloaded from the
internet is **refused outright** on other people's machines, with no obvious way
past it. Signing is not optional for distribution.

1. Join the Apple Developer Program ($99/year) and create a **Developer ID
   Application** certificate.
2. Export it as a `.p12`; set `CSC_LINK` and `CSC_KEY_PASSWORD`.
3. Add `notarize: true` under `mac:` and authenticate with an App Store Connect
   API key — `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. (An
   `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` triple also
   works, but API keys are better suited to CI.)

`hardenedRuntime: true` is already set in the config; notarization rejects
builds without it.

### Linux

AppImages are conventionally distributed unsigned.

## Auto-update

Not currently wired up. Adding it means `electron-updater` plus a publish target
(GitHub Releases is the usual choice), and it raises the stakes on signing:
unsigned updates are refused on macOS. It also needs a `zip` target alongside
`dmg` on macOS — electron-updater cannot apply an update from a `.dmg` alone.

## Gotchas

**`ELECTRON_RUN_AS_NODE`.** VS Code is itself an Electron app and exports this
variable to the processes it spawns, which turns `electron .` into "run this as
plain Node". The failure is deeply misleading: Node loads `main.mjs`, resolves
`"electron"` to the npm package whose export is a *path string*, and reports
`does not provide an export named 'BrowserWindow'` — which reads like an ES
module interop bug and is nothing of the sort. `electron/start.mjs` strips the
variable before launching, so `npm run desktop` is immune; a bare `electron .`
from an editor terminal is not.

**The Electron version must be pinned exactly.** `"electron": "43.2.0"`, not
`"^43.2.0"`. electron-builder downloads binaries for one specific release and
cannot resolve a range through the hoisted workspace `node_modules`.

**The desktop package mirrors the server's dependencies.** The esbuild bundle
leaves npm packages external, and electron-builder only collects what
`electron/package.json` itself declares — so the server's runtime dependencies
are duplicated there. `electron/build.mjs` fails the build if the two lists drift
apart, because the failure mode otherwise is nasty: it works in development
(where the workspace root hoists everything) and is missing from the installer.

**`@napi-rs/canvas` is excluded.** pdfjs-dist pulls it in as an optional
dependency for rasterizing pages — 36 MB, and native. Scibrarian only reads the
text layer, so the config drops it. If server-side PDF *rendering* is ever
added, remove that exclusion from `files:`.
