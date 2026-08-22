// Compiles the server's TypeScript into one ESM file the Electron main process
// can import. Replaces tsx, which is a dev dependency and would mean shipping a
// TypeScript compiler inside the app just to run it.
//
// Only our own sources are bundled (server/src + shared); npm dependencies stay
// external and are resolved from node_modules at runtime. That's deliberate:
// express and multer do the dynamic-require tricks that bundlers famously
// mangle, and pdfjs-dist resolves assets relative to its own location. Nothing
// here is native code, so there is no rebuild step either way — bundling them
// would buy a smaller tree in exchange for a class of subtle runtime breakage.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

// The Pro module, if this checkout has one. src/index.ts is the presence test
// rather than the directory: pro/ survives a `git clean` as an empty shell more
// often than you would think, and an empty directory must read as "no Pro".
const proSrc = path.join(repoRoot, "pro", "src", "index.ts");
const proBuild = path.join(repoRoot, "pro", "build.mjs");
const proBundle = path.join(repoRoot, "pro", "dist", "index.js");
// Inside bundle/, so the one `files` entry that already ships the server ships
// this too — see bundlePro() for why it must be exactly here.
const proPackage = path.join(here, "bundle", "node_modules", "@scibrarian", "pro");

const hasPro = () => fs.existsSync(proSrc);

// Because the bundle leaves npm dependencies external, the packaged app has to
// carry them — and electron-builder only collects what *this* package declares.
// So the server's runtime dependencies are mirrored into package.json here, and
// the two lists have to agree: a dependency added to the server but not mirrored
// would work in dev (hoisted into the workspace root's node_modules) and then be
// missing from the installer, which is the worst place to find out. Fail the
// build instead.
//
// The duplication is load-bearing, not an oversight. electron-builder decides
// what to collect by running `npm list --omit dev` against electron/package.json
// as it exists on disk, so the list has to be there, in that file, before
// packaging starts — which also means adding one requires an `npm install`
// before the next build, hence the reminder in the error below. Deriving it at
// config time via extraMetadata only rewrites the package.json written *into*
// the app; see the note in electron-builder.config.cjs.
// Dependencies main.mjs imports itself, rather than the bundled server. They
// carry the same requirement as the server's — declared in package.json here or
// missing from the installer — but they have no manifest to be compared against,
// so there is no range to agree with and presence is the whole check.
//
// Named by hand rather than read out of main.mjs's imports. The point of the
// check below is that "declared here, imported by nothing" is a shipping bug,
// and a rule that derived the list from the imports would let any stale entry
// launder itself into the manifest by being in the list. Both directions are
// checked against main.mjs instead.
const MAIN_PROCESS_ONLY = ["electron-updater"];

function assertDependenciesMirrorServer() {
  const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  const desktop = read(path.join(here, "package.json")).dependencies ?? {};
  // The Pro bundle leaves its bare imports external for the same reasons the
  // server's does, and it is loaded by the same process out of the same
  // node_modules — so on a Pro build its dependencies have to be carried here
  // as well. express is the only one today and the server already needs it,
  // which is why this has never had anything to add.
  const sources = [
    { of: "server", deps: read(path.join(repoRoot, "server", "package.json")).dependencies ?? {} },
  ];
  if (hasPro()) {
    const deps = read(path.join(repoRoot, "pro", "package.json")).dependencies ?? {};
    sources.push({ of: "pro", deps });
  }

  const drift = [];
  // Each source checked against the manifest on its own, rather than merged
  // into one list of requirements first. A merge answers a disagreement instead
  // of reporting it: `{...server, ...pro}` let pro's range win, so express at
  // ^4.21.2 in the server and ^4.18.0 in pro left one satisfiable requirement,
  // no complaint, and the server's own range never checked again — an installer
  // shipping a version the server was not tested against. Compared apart, one
  // declared range cannot satisfy both and the message names who wants what.
  for (const { of: source, deps } of sources) {
    for (const [name, range] of Object.entries(deps)) {
      if (!(name in desktop)) drift.push(`missing "${name}": "${range}" (${source} needs it)`);
      else if (desktop[name] !== range) {
        drift.push(`"${name}" is ${desktop[name]}, ${source} wants ${range}`);
      }
    }
  }

  const mainSource = fs.readFileSync(path.join(here, "main.mjs"), "utf8");
  // Specifiers of real import statements, not every mention of the name. The
  // comment above main.mjs's electron-updater import quotes the specifier while
  // explaining why the named form of it fails, and a substring match reads that
  // as proof — so deleting the import and keeping the comment passed a module
  // nothing imports any more. Comment lines start with `//`, so anchoring to
  // `import` at the start of a line steps around them.
  //
  // Either quote character, and the trailing semicolon optional, because the
  // only thing this is meant to detect is whether the import is there. A style
  // change failing the build with `main.mjs does not import it` would point at
  // the one thing that was not wrong. `[^;]` spans newlines, so a specifier
  // wrapped across lines is already covered; the backreference is what keeps
  // the two quotes the same one.
  const imported = new Set(
    [...mainSource.matchAll(/^import\s[^;]*?from\s+(["'])([^"']+)\1/gm)].map((m) => m[2])
  );
  for (const name of MAIN_PROCESS_ONLY) {
    if (!(name in desktop)) drift.push(`missing "${name}": main.mjs imports it`);
    // The other direction: an entry that outlived the import it was added for
    // would silently exempt itself from the "imported by nothing" check below.
    if (!imported.has(name)) {
      drift.push(`"${name}" is listed as main-process-only, but main.mjs does not import it`);
    }
  }

  const wanted = new Set([...sources.flatMap((s) => Object.keys(s.deps)), ...MAIN_PROCESS_ONLY]);
  const extra = Object.keys(desktop).filter((name) => !wanted.has(name));
  if (extra.length > 0) {
    if (hasPro()) {
      for (const name of extra) drift.push(`"${name}" is not a dependency of the bundled code`);
    } else {
      // Only fatal when the whole picture is here. A free checkout cannot read
      // pro's manifest, so a dependency that only Pro imports is
      // indistinguishable from one nothing imports any more — and throwing on
      // the pair of them made a Pro-only dependency impossible to declare
      // without breaking every public desktop build, which is the reverse of
      // what this check is for. Said out loud rather than passed over, and the
      // Pro build that whoever adds one is running still refuses a stale entry.
      console.warn(
        `[desktop] Unverified: ${extra.join(", ")} — declared here, imported by nothing in this ` +
          "checkout. Either Pro-only or stale; a Pro checkout can tell the difference."
      );
    }
  }

  if (drift.length > 0) {
    throw new Error(
      "electron/package.json dependencies have drifted from what the bundle imports:\n" +
        drift.map((d) => `  - ${d}`).join("\n") +
        "\nSync them (then run npm install) so the packaged app ships what the bundle imports."
    );
  }
}

// electron-builder copies ../client/dist in as extraResources, and nothing in
// the packaging scripts builds it — so on a fresh clone it simply isn't there,
// and a desktop build would otherwise be assembled around a missing (or, worse,
// silently stale) UI. Check it here, where every packaging path passes through.
function assertClientIsBuilt() {
  const dist = path.join(repoRoot, "client", "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    throw new Error(
      `The built client is missing from ${dist}.\n` +
        "Run `npm run build -w client` first, or use the root scripts that do it for you:\n" +
        "  npm run desktop        (build + launch in dev)\n" +
        "  npm run desktop:pack   (unpacked app)\n" +
        "  npm run desktop:dist   (installers)"
    );
  }
}

/**
 * Put the Pro module where the bundled server can resolve it, on a checkout
 * that has one. Returns whether this is a Pro build.
 *
 * The desktop app is the *spoke* half of shared holdings: it pairs with a
 * remote master and reads its holdings back down. All of that lives in pro/,
 * loaded through `loadPro()`'s dynamic `import("@scibrarian/pro")` inside the
 * server bundle — a bare specifier resolved at runtime, because the specifier
 * is a variable and no bundler can follow it (see pro-hooks.ts for why it has
 * to stay one). So the job here is not to bundle the module *into* the server;
 * it is to leave a resolvable package next to it.
 *
 * Exactly here, and not the two places that look equivalent:
 *
 *  - Not the `node_modules/@scibrarian/pro` junction that pro/link.mjs makes at
 *    the repository root. Its `exports` points at src/index.ts, which is
 *    TypeScript — fine under tsx, which is how `npm run dev -w server` uses it,
 *    and unloadable by Electron's plain Node. It is also outside everything
 *    electron-builder collects, so it would go missing from the installer.
 *  - Not electron/node_modules. electron-builder fills that from `npm list
 *    --omit dev` against electron/package.json, so a directory no manifest
 *    declares is simply not collected — and declaring a private, unpublished
 *    package there is not something `npm install` can satisfy.
 *
 * bundle/node_modules is the one location that answers both halves: Node walks
 * up from bundle/server.mjs and finds it first, ahead of the dev junction, and
 * `files: ["bundle/**"]` already carries the whole directory into the asar.
 *
 * The module is copied in compiled, never as source, and pro/build.mjs is run
 * rather than reimplemented here — its esbuild settings are load-bearing (no
 * sourcemap, or the installer would carry the proprietary TypeScript inline)
 * and must not acquire a second, drifting copy in the public repository.
 */
function bundlePro() {
  // A stale copy from an earlier Pro build is the failure this removal exists
  // for: park pro/, rebuild, and without it the "free" installer would quietly
  // ship the proprietary module that was already sitting in bundle/. Only ever
  // this subtree, which nothing but this function writes.
  fs.rmSync(path.join(here, "bundle", "node_modules"), { recursive: true, force: true });

  // Absence is not a failure — a free checkout has no pro/ and builds a
  // complete desktop app without it. Presence that then goes wrong is fatal,
  // which is the same line loadPro() draws at runtime and for the same reason:
  // a silent downgrade looks like the product working.
  if (!hasPro()) return false;

  const built = spawnSync(process.execPath, [proBuild], { stdio: "inherit", cwd: repoRoot });
  if (built.error) throw new Error(`Could not run ${proBuild}: ${built.error.message}`);
  // Signal before status, because a child that was killed reports status null
  // and "failed with exit code null" names nothing. An OOM kill on a small
  // machine is the likely one, and this is the build path where knowing why
  // matters: what a swallowed Pro failure produces is a free installer wearing
  // the Pro build's name.
  if (built.signal) throw new Error(`${proBuild} was killed by ${built.signal}.`);
  if (built.status !== 0) throw new Error(`${proBuild} failed with exit code ${built.status}`);
  if (!fs.existsSync(proBundle)) {
    throw new Error(`${proBuild} reported success but produced no ${proBundle}.`);
  }

  fs.mkdirSync(proPackage, { recursive: true });
  fs.copyFileSync(proBundle, path.join(proPackage, "index.js"));
  // Written rather than copied, exactly as Dockerfile.pro writes its own: the
  // repository's manifest points `exports` at src/index.ts to keep local
  // development untranspiled, and there is no src/ here to point at. No
  // dependencies either — express resolves from the app's node_modules by the
  // ordinary upward walk.
  fs.writeFileSync(
    path.join(proPackage, "package.json"),
    JSON.stringify(
      {
        name: "@scibrarian/pro",
        private: true,
        license: "UNLICENSED",
        type: "module",
        exports: { ".": "./index.js" },
      },
      null,
      2
    ) + "\n"
  );
  // Written, copied, and *resolvable* are three different claims, and only the
  // third is the one runtime makes. Everything above proves files are on disk in
  // a directory this function chose; what loadPro() does is ask Node to resolve a
  // bare specifier from the server bundle's location, and it reads a failure
  // there as "no Pro installed" — the silent downgrade this function exists to
  // prevent, arrived at through the code meant to prevent it. So the resolution
  // is performed here, for real.
  //
  // In a child process with cwd set, rather than import.meta.resolve() from this
  // file: this file lives in electron/, and from there the dev junction at the
  // repository root answers first, hiding the exact layout mistake being checked
  // for. An eval'd module resolves upward from cwd, so cwd is what makes this ask
  // the question the packaged app will ask.
  const resolves = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "console.log(import.meta.resolve('@scibrarian/pro'))"],
    { cwd: path.join(here, "bundle"), encoding: "utf8" }
  );
  if (resolves.status !== 0) {
    throw new Error(
      "@scibrarian/pro was written to bundle/node_modules but does not resolve from " +
        "electron/bundle, which is where the bundled server asks for it. A packaged app " +
        "built from this would run as a free build with nothing reporting a problem.\n" +
        (resolves.stderr || "").trim()
    );
  }

  // Where it resolved *to*, not merely that it resolved. The walk upward from
  // bundle/ carries on into electron/node_modules and the repository root, and
  // the root is where pro/link.mjs leaves a junction on any machine that runs
  // the server from source. Checking only for success would therefore let a
  // missing bundle/node_modules be answered by a directory the installer does
  // not carry — passing on precisely the machine doing the packaging, which is
  // the only machine that ever runs this.
  const at = (resolves.stdout || "").trim();
  const want = pathToFileURL(path.join(proPackage, "index.js")).href;
  if (at !== want) {
    throw new Error(
      `@scibrarian/pro resolves to ${at} from electron/bundle, not to the copy just ` +
        `written at ${want}. The installer carries bundle/ and nothing above it, so the ` +
        `packaged app would resolve something else or nothing at all.`
    );
  }

  return true;
}

assertDependenciesMirrorServer();
assertClientIsBuilt();

await build({
  entryPoints: [path.join(repoRoot, "server", "src", "index.ts")],
  // Not dist/ — that belongs to electron-builder's installer output.
  outfile: path.join(here, "bundle", "server.mjs"),
  bundle: true,
  platform: "node",
  // ESM, matching the source: the server is written as ESM ("type": "module"),
  // and config.ts derives paths from import.meta.url, which has no meaning in a
  // CJS output and would silently become undefined.
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});

// After the server, so the line below is the last thing on screen: which tier
// was just built is the one thing about a desktop build you cannot tell by
// looking at the output directory.
console.log(
  bundlePro()
    ? "[desktop] Pro build: @scibrarian/pro compiled into bundle/node_modules"
    : "[desktop] Free build: no pro/ in this checkout"
);
