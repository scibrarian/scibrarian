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
const fs = require("node:fs");
const path = require("node:path");

// The staged Pro entry point, relative to the app root. Forward slashes because
// the same string is what afterPack looks for *inside* app.asar; only the
// on-disk checks split it into segments.
const PRO_ENTRY = "bundle/node_modules/@scibrarian/pro/index.js";

// Is this a Pro build? The same expression afterPack uses — not a second copy of
// it — for the same reason: build.mjs removes bundle/node_modules before every
// build and recreates it only on a checkout that has pro/, and it has already
// run by the time this file is evaluated (`node build.mjs && electron-builder`
// in package.json).
const isProBuild = fs.existsSync(path.join(__dirname, ...PRO_ENTRY.split("/")));

// Where electron-updater looks for new versions. Its *presence* is what makes
// electron-builder emit latest*.yml and write app-update.yml into the packaged
// resources — with no publish key at all, neither file exists and autoUpdater
// has nothing to read.
//
// One feed per tier, and they must never cross. The public repo can only ever
// release free builds — pro/ is gitignored there, so desktop-release.yml has no
// module to ship — which means a Pro installer pointed at it would update
// itself into the free build. loadPro() reads the result as "Pro isn't
// installed", so the freelancer loses pairing while the version number goes up
// and nothing reports a problem. Pro therefore has a feed of its own:
// scibrarian-desktop-releases, a public repository holding installers and no
// source, so the provider needs no token and the Pro sources stay private.
//
// afterPack below asserts that what actually got packed matches the tier that
// packed it.
//
// The account, and the free build's repository with it, are read from whatever
// repository is being built rather than written down here. desktop-release.yml
// uploads to $GITHUB_REPOSITORY, so a fork that inherited this project's names
// would ship installers that update themselves into *our* releases and never
// see the fork's own — the same silent replacement the two tiers guard against,
// one level up. The Pro repository is a fixed name because it holds installers
// and no source: a fork building Pro publishes to the same name under its own
// account. Outside CI the variable is unset, and the fallbacks are the only
// account and repository either feed has lived under.
const [ciOwner, ciRepo] = (process.env.GITHUB_REPOSITORY || "").split("/");
const OWNER = ciOwner || "scibrarian";
const PRO_REPO = "scibrarian-desktop-releases";
const FREE_REPO = ciRepo || "scibrarian";

const publish = [
  { provider: "github", owner: OWNER, repo: isProBuild ? PRO_REPO : FREE_REPO },
];

// Said out loud for the reason the [signing] lines are: an auto-update feed you
// believe is wired and isn't — or is wired into the wrong tier — is not visible
// in any artifact you can look at afterwards.
console.log(
  `[updates] ${isProBuild ? "pro" : "free"} build: github ${publish[0].owner}/${publish[0].repo}`
);

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

  publish,

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

  // The half build.mjs cannot check. It verifies that @scibrarian/pro resolves
  // from electron/bundle *on disk*; what reaches a user is whatever `files`
  // collected into the archive, and a glob edit can drop the directory with
  // nothing failing. The installer would then run as a free build in a paying
  // customer's hands — loadPro reads an unresolvable specifier as "not
  // installed", which is the one failure that looks like the product working.
  //
  // Asserted against the packed artifact rather than the inputs, because the
  // gap being closed is precisely between the two.
  afterPack: async (context) => {
    const resources =
      typeof context.packager.getResourcesDir === "function"
        ? context.packager.getResourcesDir(context.appOutDir)
        : context.electronPlatformName === "darwin"
          ? path.join(
              context.appOutDir,
              `${context.packager.appInfo.productFilename}.app`,
              "Contents",
              "Resources"
            )
          : path.join(context.appOutDir, "resources");

    // app-update.yml is written by a *system* afterPack listener, and system
    // listeners run before user ones — AsyncEventEmitter.emit sorts them and
    // says so ("user handlers are always last") — so it is already on disk here.
    //
    // Its presence is checked against the tier; its absence never is. A build
    // with no feed cannot auto-update at all, which main.mjs handles by looking
    // for this same file, and which is the ordinary state of a `--dir` pack on
    // macOS and Windows — the listener above returns early without a dmg/zip or
    // NSIS target in the build. Linux is not guarded that way, so a `--dir` pack
    // there does get a feed and does reach this check, which is fine: it is the
    // same feed the real build would carry, so it passes for the same reason. A
    // build carrying the *other* tier's feed is the one worth failing over: a
    // Pro install that replaces itself with the free build, loses pairing, and
    // reports a higher version number for it.
    const updateYml = path.join(resources, "app-update.yml");
    if (fs.existsSync(updateYml)) {
      // Both halves of the feed, because either one alone names a release page
      // this build does not publish to: the wrong repo is the other tier, and
      // the wrong owner is another account entirely — which a check that read
      // only `repo` waved through, since both tiers' names live under both.
      const feed = fs.readFileSync(updateYml, "utf8");
      const packed = `${/^owner:\s*(\S+)/m.exec(feed)?.[1]}/${/^repo:\s*(\S+)/m.exec(feed)?.[1]}`;
      const expected = `${OWNER}/${isProBuild ? PRO_REPO : FREE_REPO}`;
      if (packed !== expected) {
        throw new Error(
          `This is a ${isProBuild ? "Pro" : "free"} build, but its update feed points at ` +
            `"${packed}" instead of "${expected}". Every install made from this ` +
            "installer would update itself out of this build's own releases — into the " +
            "other tier, or into another account's. Check `publish` above."
        );
      }
      console.log(`  • verified update feed: ${packed}`);
    }

    // Presence of the staged copy is exactly "this is a Pro build", which is
    // what isProBuild above already reads. A free build must pack without it,
    // and does, so there is nothing here to assert.
    if (!isProBuild) return;

    // asar is on above, and this reads the archive rather than assuming it: a
    // build with asar turned off lays the same tree out under resources/app,
    // and a check that only knew one of the two would fail on the other for a
    // reason that has nothing to do with Pro.
    const archive = path.join(resources, "app.asar");
    const packed = fs.existsSync(archive)
      ? require("@electron/asar")
          .listPackage(archive)
          // Entries come back separator-joined by the machine that packed and
          // with a leading separator, so both are normalised away before
          // comparing. path.sep is that separator: this is listing an archive
          // written moments ago by this same process.
          .map((e) => e.split(path.sep).join("/"))
          .some((e) => (e.startsWith("/") ? e.slice(1) : e) === PRO_ENTRY)
      : fs.existsSync(path.join(resources, "app", ...PRO_ENTRY.split("/")));

    if (!packed) {
      throw new Error(
        `This is a Pro build, but ${PRO_ENTRY} is not in the packaged app at ${resources}. ` +
          "The installer would run as a free build with nothing reporting a problem. " +
          "Check the `files` globs above."
      );
    }

    // Said out loud, because a silent check is indistinguishable from one that
    // did not run — which is the state this hook was added to end. The build
    // already names the tier it produced; this names the tier it verified.
    console.log(`  • verified in app.asar: ${PRO_ENTRY}`);
  },

  win: {
    target: "nsis",
    icon: "build/icon.ico",
    ...signing.win,
  },

  nsis: {
    // Default is `${productName} Setup ${version}.${ext}` — with spaces, and
    // that breaks auto-update here specifically because we publish with `gh`
    // rather than letting electron-builder do it. latest.yml always refers to
    // the artifact by its *safe* name (spaces to hyphens), which is what
    // electron-builder's own GitHub publisher would have uploaded it under;
    // `gh release upload` uploads it under the name on disk, and GitHub turns
    // the spaces into dots. The feed would then point at Scibrarian-Setup-x.exe
    // while the release holds Scibrarian.Setup.x.exe, and every Windows update
    // 404s. Naming it safely on disk keeps all three the same string.
    artifactName: "${productName}-Setup-${version}.${ext}",
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },

  mac: {
    // zip alongside dmg because Squirrel.Mac cannot apply a .dmg — the dmg is
    // what a person downloads, the zip is what electron-updater downloads, and
    // latest-mac.yml points at the latter. Dropping it does not fail any build;
    // it just means macOS silently never updates.
    target: ["dmg", "zip"],
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
