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

That directory is the thing to back up, and deleting it resets the app to a
first run.

Only Windows has an uninstaller, so it is the only platform where uninstalling
can offer to take the library with it — `electron/build/installer.nsh` asks,
defaulting to keeping the data. Two cases deliberately never ask: an in-place
upgrade, where the installer runs the old uninstaller with `--updated`, and a
silent uninstall (`/S`), which keeps the data unless you also pass
`--delete-app-data`.

A dmg is drag-to-Applications and an AppImage is a single file, so on macOS and
Linux there is no uninstall step to hook — trashing the app or deleting the
AppImage leaves the directory behind. Remove it by hand:

```bash
rm -rf ~/Library/Application\ Support/Scibrarian   # macOS
rm -rf ~/.config/Scibrarian                        # Linux
```

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
| Windows | NSIS | `Scibrarian-Setup-<version>.exe` |
| macOS | dmg, zip | `Scibrarian-<version>.dmg` and `Scibrarian-<version>-mac.zip` (non-x64 adds the arch before both suffixes: `-arm64`, `-universal`) |
| Linux | AppImage | `Scibrarian-<version>.AppImage` |

**The macOS `.zip` is not a second download — do not prune it from a release.**
Squirrel.Mac cannot apply a `.dmg`, so the dmg is what a person installs from and
the zip is what `electron-updater` fetches; `latest-mac.yml` names the zip. Leave
it off the release and macOS updates resolve to a file that was never attached,
which nothing on the publishing side reports.

Note the macOS suffix if you are scripting a download URL against a release:
every dmg CI publishes is built `--universal` (see [Releasing from CI](#releasing-from-ci)),
so the released names are always `Scibrarian-<version>-universal.dmg` and
`Scibrarian-<version>-universal-mac.zip`. The bare `Scibrarian-<version>.dmg` is
what a plain local build gives you on an Intel Mac, and it is not what ends up
attached to a release.

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

### How it is wired

`electron/signing.config.cjs` holds the signing setup and is merged into `win`
and `mac` by `electron-builder.config.cjs`. It holds no secrets and is meant to
be committed: certificates, passwords and API keys are read from the
environment, and signing switches itself on when they appear.

So an unsigned build is not something anyone opts out of — it is what you get
with nothing set, locally and in a fork's CI alike. Every build prints one line
per platform it is producing:

```
[signing] windows: unsigned
[signing] macos: certificate file, notarized via App Store Connect API key
```

Per platform *built*, not per platform you happen to be on: `--linux` from a Mac
prints the Linux line alone, and `-mwl` prints all three. Worth reading — a
release you believe is signed and isn't is the failure this arrangement exists
to catch, and a line about an artifact the run never produced would defeat it.

For signed builds on your own machine, copy the environment template once:

```bash
cp .env.signing.example .env.signing     # gitignored
```

Fill in the section for your platform and `npm run desktop:dist` picks it up
with no further ceremony. In CI the same variables are repository secrets — see
[Releasing from CI](#releasing-from-ci).

### Windows

Without a signature, every download shows a SmartScreen warning that the user
must click past ("More info" → "Run anyway"). Nothing is blocked outright.

Since the 2023 CA/Browser Forum rules, newly issued OV certificates require a
hardware token or a cloud HSM, so the old "point `CSC_LINK` at a `.pfx`" flow
only works for certificates issued before that. Current options:

- **Azure Trusted Signing** — roughly $10/month, cloud-based, no hardware.
  Requires identity validation; individuals need about three years of verifiable
  operating history. Set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
  `AZURE_CLIENT_SECRET` for a service principal holding the *Trusted Signing
  Certificate Profile Signer* role, then replace the four account details in the
  `REPLACE ME` block at the top of `signing.config.cjs`. Signing shells out to
  PowerShell's `Invoke-TrustedSigning`, so it only runs on a Windows machine.

  Authentication is Azure's `EnvironmentCredential`, not anything
  electron-builder implements, so the two alternatives it accepts work as well:
  `AZURE_CLIENT_CERTIFICATE_PATH` in place of the secret, or an
  `AZURE_USERNAME` + `AZURE_PASSWORD` pair. As with notarization, set a
  credential set completely — a partial one is refused rather than ignored,
  since ignoring it means shipping an unsigned installer from a green build.
- **EV certificate on a hardware token** — expensive, but carries SmartScreen
  reputation immediately.
- **A pre-2023 OV certificate** — `WIN_CSC_LINK` (path or base64 of the `.pfx`)
  plus `WIN_CSC_KEY_PASSWORD`, and nothing to configure beyond that. Reputation
  still accrues over the first few hundred downloads.

Setting the Azure credentials while leaving the account details as `REPLACE_ME`
fails the build immediately, on purpose: the alternative is a ten-minute build
that dies inside PowerShell with an Azure error naming none of them.

### macOS

Gatekeeper is stricter than SmartScreen: an unsigned app downloaded from the
internet is **refused outright** on other people's machines, with no obvious way
past it. Signing is not optional for distribution — and signing alone is not
enough, because the app also has to be notarized by Apple.

1. Join the Apple Developer Program ($99/year) and create a **Developer ID
   Application** certificate.
2. Export it as a `.p12`; set `CSC_LINK` (path or base64) and `CSC_KEY_PASSWORD`.
3. Create an App Store Connect API key and set `APPLE_API_KEY`,
   `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. (An `APPLE_ID` +
   `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` triple also works, but API
   keys are better suited to CI.)

There is no `notarize: true` to set. electron-builder 26 notarizes whenever one
of those credential sets is in the environment — it is opt-*out* — so
`signing.config.cjs` sets `notarize: false` when there is nothing to notarize
with, and a build without credentials says so plainly instead of warning about
options it "was unable to generate".

Set a credential set **completely or not at all**. Two of the three variables is
the dangerous state: it reads as "no notarization", and an opted-out build
produces a signed dmg that Gatekeeper still refuses, discovered by users rather
than by you. `signing.config.cjs` refuses to start such a build and names the
missing variable.

`APPLE_API_KEY` is a **path to the `.p8` file**, not its contents; notarytool
takes it as `--key`. Apple also lets you download any given `.p8` exactly once.

`hardenedRuntime: true` is already set in the packaging config — notarization
rejects builds without it — and electron-builder's default entitlements
(`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`)
are the ones an Electron app needs, so there is no entitlements file to add.

On a Mac that already has a Developer ID in its keychain, electron-builder finds
and uses it even with nothing set, which is convenient right up until you are
trying to reproduce what a contributor without certificates gets.
`CSC_IDENTITY_AUTO_DISCOVERY=false` turns that off.

### Linux

AppImages are conventionally distributed unsigned. Nothing to configure.

### Releasing from CI

`.github/workflows/desktop-release.yml` builds all three platforms on a `v*` tag
push or a manual run, then drafts a GitHub release with the installers attached.
It is a template in the same sense as everything above: it runs today and
produces unsigned artifacts, and it starts signing once the secrets exist — no
edit either way, because an unset secret arrives as an empty string and empty
counts as unset.

| Secret | For |
|---|---|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | Windows, Azure Trusted Signing (see above for the other two credential shapes) |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows, pre-2023 `.pfx` (base64) |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | macOS Developer ID `.p12` (base64) |
| `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | macOS notarization |

`APPLE_API_KEY_P8` holds the *contents* of the `.p8` — the workflow writes it to
a file on the runner and points `APPLE_API_KEY` at that path, since the variable
is a path. The four Azure account names can be repository **variables** of the
same name instead of living in `signing.config.cjs`.

Two things there are deliberate. It is a separate workflow from `ci.yml` because
it installs the electron workspace, whose postinstall pulls a ~350 MB Chromium
per runner — three of them — which has no business on the per-push path. And the
macOS build passes `--universal`, because `macos-latest` is arm64 and a default
build there produces a dmg that silently will not run on any Intel Mac.

The release is created as a **draft**: installers are worth downloading and
launching once before anyone else gets them. Re-running the workflow uploads
into that draft. Once the release is published the workflow refuses to touch it
and fails instead — a manual run takes its tag from `package.json`, which still
reads the last released version until the next bump, so without that guard a
dispatch from `main` would replace shipped installers with a fresh build under
an unchanged version number.

### Checking the result

The `[signing]` lines report what the build intended. These report what it
actually produced:

```powershell
# Windows
Get-AuthenticodeSignature electron\dist\*.exe | Format-List Path, Status, SignerCertificate
```

```bash
# macOS — signature, Gatekeeper's verdict, then the notarization ticket
codesign --verify --deep --strict --verbose=2 electron/dist/mac*/Scibrarian.app
spctl --assess --type execute --verbose electron/dist/mac*/Scibrarian.app
xcrun stapler validate electron/dist/mac*/Scibrarian.app
```

`spctl` is the one that matters: it is the same check the user's Mac runs.

Ignore electron-builder's own `signing with signtool.exe` line on Windows. It
names the step that stamps icon and version metadata into the executable, and it
is printed whether or not a certificate exists — an unsigned build logs it and
then produces a binary `Get-AuthenticodeSignature` reports as `NotSigned`.

## Auto-update

Wired up, and on in both tiers — each following a feed of its own.

`electron/main.mjs` checks once at startup (`startUpdateChecks`), downloads a new
version in the background if there is one, and shows an OS notification when it
is staged; the update applies on the next quit. Nothing interrupts a session and
the renderer has no UI for it.

The feed is GitHub Releases on this repository, declared as `publish` in
`electron-builder.config.cjs`. That declaration is also what makes
electron-builder emit `latest*.yml` beside the installers and write
`app-update.yml` into the packaged resources — with no `publish` key at all,
neither file exists and `autoUpdater` has nothing to read.

"This repository" is meant literally: in CI the account and repository name come
from `$GITHUB_REPOSITORY`, which is where `desktop-release.yml` uploads. A fork's
installers therefore follow the fork's own releases rather than this project's.
Outside CI the variable is unset and the names fall back to `scibrarian`.

**Pro builds follow a feed of their own**, `scibrarian/scibrarian-desktop-releases`
— a public repository holding installers and no source. It has to be a separate
one, because the public repository cannot produce a Pro installer: `pro/` is
gitignored there, so a Pro build pointed at the feed above would update itself
into the free build, `loadPro()` would read the result as "Pro isn't installed",
and the freelancer would lose pairing while the version number went up with
nothing reporting a problem. Public so the provider needs no token — only
compiled installers are published there, never `pro/src`.

Crossing the two feeds is the failure worth catching before an installer exists,
so `afterPack` reads the `app-update.yml` that was actually packed and refuses a
build whose feed does not match its tier. Every build names both:

```
[updates] pro build: github scibrarian/scibrarian-desktop-releases
  • verified update feed: scibrarian/scibrarian-desktop-releases
  • verified in app.asar: bundle/node_modules/@scibrarian/pro/index.js
```

Pro installers are built and published from the private repo, by
`pro/.github/workflows/publish-pro-desktop.yml` — it assembles the two halves
the same way the image workflow does, because this repository's CI structurally
cannot.

**macOS needs the signing above to be real.** Gatekeeper refuses an unsigned
update outright, so an unsigned mac build does not auto-update — though it is
also a build you cannot distribute, so this costs nothing extra. The `mac`
target is `["dmg", "zip"]` because Squirrel.Mac cannot apply a `.dmg`: the dmg is
what a person installs from, the zip is what the updater fetches, and
`latest-mac.yml` names the zip.

**Nothing reaches users until you publish the draft.** The GitHub provider
cannot see draft releases, so the draft `desktop-release.yml` creates is
invisible to every installed copy until you publish it. That is the release
step, and it is the same button that was already worth pressing deliberately.

CI passes `--publish never` to all three builds. Without it electron-builder
infers a policy from the tag and uploads the artifacts itself, alongside the
release job and around that job's refusal to overwrite a published release. The
`latest*.yml` files are written either way — they come from the publish *config*,
not from the publish action.

## Gotchas

**`ELECTRON_RUN_AS_NODE`.** VS Code is itself an Electron app and exports this
variable to the processes it spawns, which turns `electron .` into "run this as
plain Node". The failure is deeply misleading: Node loads `main.mjs`, resolves
`"electron"` to the npm package whose export is a *path string*, and reports
`does not provide an export named 'BrowserWindow'` — which reads like an ES
module interop bug and is nothing of the sort. `electron/start.mjs` strips the
variable before launching, so `npm run desktop` is immune; a bare `electron .`
from an editor terminal is not.

**`electron-updater` has no named exports.** It is CommonJS, and Node's lexer
cannot detect its exports through it, so `import { autoUpdater } from
"electron-updater"` fails at link time with `Named export 'autoUpdater' not
found` — before a line of `main.mjs` runs, and reading like a broken install
rather than an interop rule. Import the default and destructure it.

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
