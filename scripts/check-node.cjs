// Runs as a preinstall guard so an unsupported Node version fails fast with a
// clear message, instead of the cryptic native-build error you get when
// better-sqlite3 has no prebuilt binary for your Node version.
const MIN = 20;
const MAX = 26; // tested on 22; better-sqlite3's prebuilds cover 20–26
const major = Number(process.versions.node.split(".")[0]);

if (!Number.isFinite(major) || major < MIN || major > MAX) {
  console.error(
    "\n" +
      `  sciluminate requires Node ${MIN}–${MAX} (tested on Node 22).\n` +
      `  You're on Node ${process.versions.node}, which has no prebuilt better-sqlite3\n` +
      "  binary and will fail to build from source without C++ build tools.\n\n" +
      "  Fix it with nvm:   nvm install 22 && nvm use 22\n" +
      "  (or install any Node 20–26), then run npm install again.\n"
  );
  process.exit(1);
}
