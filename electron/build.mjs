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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

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
function assertDependenciesMirrorServer() {
  const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
  const server = read(path.join(repoRoot, "server", "package.json")).dependencies ?? {};
  const desktop = read(path.join(here, "package.json")).dependencies ?? {};

  const drift = [];
  for (const [name, range] of Object.entries(server)) {
    if (!(name in desktop)) drift.push(`missing "${name}": "${range}"`);
    else if (desktop[name] !== range) drift.push(`"${name}" is ${desktop[name]}, server wants ${range}`);
  }
  for (const name of Object.keys(desktop)) {
    if (!(name in server)) drift.push(`"${name}" is not a server dependency`);
  }

  if (drift.length > 0) {
    throw new Error(
      "electron/package.json dependencies have drifted from server/package.json:\n" +
        drift.map((d) => `  - ${d}`).join("\n") +
        "\nSync them (then run npm install) so the packaged app ships what the server imports."
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
