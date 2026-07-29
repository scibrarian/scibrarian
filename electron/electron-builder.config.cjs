// Packaging config for the desktop build (`npm run desktop:pack` / `desktop:dist`).
//
// JavaScript rather than YAML for one reason: the version. electron-builder
// takes it from the app's own package.json, which would make electron/ a second
// place the release number lives — and a desktop installer labelled 0.5.0 built
// alongside a 0.6.0 Docker image is the kind of mismatch nobody notices until a
// user reports it. Reading the root manifest here keeps one source of truth.
//
// Signing lives in signing.config.cjs, merged into `win` and `mac` below. It
// stays out of this file because it is the part you are expected to edit: it
// turns itself on when certificates are present in the environment and off when
// they aren't, so an unsigned local build remains the default here.
const { version } = require("../package.json");
const signing = require("./signing.config.cjs");

module.exports = {
  appId: "com.scibrarian.desktop",
  productName: "Scibrarian",
  copyright: "Copyright © Scibrarian contributors",

  // Injected into the packaged app's package.json — it does not rewrite the
  // file on disk. This is what names the artifacts and what electron-updater
  // compares, so it is the version in every sense that reaches a user.
  //
  // Do not try to derive `dependencies` the same way. It looks like it would
  // delete the duplicated list in package.json and its drift check in build.mjs,
  // and it silently would not work: extraMetadata is merged into the metadata
  // that gets *written into* the app (packager.js merges it after snapshotting
  // originalMetadata), while the node_modules actually collected come from
  // running `npm list --omit dev` against this package as it exists on disk.
  // The installer would declare eight dependencies and ship none of them —
  // failing at first launch, in a user's hands, with "Cannot find module".
  extraMetadata: { version },

  directories: {
    output: "dist",
    buildResources: "build",
  },

  // main.mjs imports bundle/server.mjs; node_modules is added automatically
  // from this package's "dependencies", which mirror the server's (see
  // build.mjs).
  files: [
    "main.mjs",
    "bundle/**",
    // No sourcemaps in a shipped installer, ours or anyone else's. Nothing reads
    // them at runtime: Node only consults a .map when source maps are explicitly
    // enabled, which is something you do on a dev machine — where the maps are
    // already sitting in electron/bundle/ and node_modules/. build.mjs keeps
    // generating ours; it just stops travelling.
    //
    // Ours is 2.6× the bundle it describes (~243 KB against 92 KB). The
    // dependencies' are the real weight: 20.6 MB across 62 files, 18.5 MB of it
    // pdfjs-dist alone.
    "!bundle/**/*.map",
    "!node_modules/**/*.map",
    "package.json",
    // pdfjs-dist pulls @napi-rs/canvas (Skia + ICU, ~36MB, and native) as an
    // optional dependency, used only to rasterise pages. pdf-text.ts extracts
    // the text layer and never renders, and extraction is verified to work
    // without it — pdfjs just logs a few "cannot polyfill DOMMatrix" warnings
    // it doesn't act on. Drop it. If PDF *rendering* is ever added server-side,
    // remove this line.
    "!node_modules/@napi-rs/**",
  ],

  // The built React client, served by the in-process Express server. Kept
  // outside the asar because it is read by path (CLIENT_DIST) rather than
  // imported, and res.sendFile on an archived path is a needless thing to
  // depend on.
  extraResources: [{ from: "../client/dist", to: "client" }],

  asar: true,

  win: {
    target: "nsis",
    icon: "build/icon.ico",
    ...signing.win,
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },

  mac: {
    target: "dmg",
    icon: "build/icon.icns",
    category: "public.app-category.education",
    // Required for a notarised build; harmless before then.
    hardenedRuntime: true,
    gatekeeperAssess: false,
    ...signing.mac,
  },

  linux: {
    target: "AppImage",
    icon: "build/icon.png",
    category: "Science",
  },
};
