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
// The EULA that governs a Pro build, and the two shippable renderings of it.
// Markdown is the source and no installer target can read it: NSIS and the dmg
// take RTF, the AppImage takes plain text, none of the three takes .md. The
// output lands in bundle/ for the same reason the module does — the one `files`
// entry that already ships the server ships this too.
const proEula = path.join(repoRoot, "pro", "EULA.md");
const eulaOut = {
  rtf: path.join(here, "bundle", "EULA.rtf"),
  txt: path.join(here, "bundle", "EULA.txt"),
};

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

// RTF is ASCII by construction. `\`, `{` and `}` are its control characters, and
// anything above 127 has to be a numeric escape — a raw UTF-8 byte comes out as
// mojibake in both the NSIS rich-edit control and the macOS SLA, and the EULA
// has six em dashes in it. `\uN?` is that escape: N is the UTF-16 code unit as a
// *signed* 16-bit number, and `?` is what a reader too old to understand \u
// shows in its place. Walking code units rather than code points is what makes a
// surrogate pair come out as the two escapes RTF expects.
function rtfEscape(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" || ch === "{" || ch === "}") {
      out += `\\${ch}`;
      continue;
    }
    const unit = text.charCodeAt(i);
    out += unit < 128 ? ch : `\\u${unit > 32767 ? unit - 65536 : unit}?`;
  }
  return out;
}

// Hard-wrapped rather than left to whatever opens it. The AppImage does not
// display its license, it files it away, so the next thing to read the plain
// text is an editor or a terminal — and a 900-character paragraph on one line is
// unreadable in both. The source's own wrapping cannot be reused: `**bold**`
// spans a line break in three places, so paragraphs have to be joined before the
// markers come off, which discards the original breaks on the way.
function wrap(text, width, hanging = 0) {
  const pad = " ".repeat(hanging);
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = pad + word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

// The token pro/EULA.md carries where Section 2 makes its Corresponding Source
// offer, and what gets replaced on the way into the installer. Braces rather than
// the [BRACKETS] the draft uses for its other blanks, because those are filled in
// by hand once and this one cannot be: it names a different commit every build.
const SOURCE_URL_TOKEN = "{{SOURCE_URL}}";

/**
 * Where the source for *this* build can be fetched, for the EULA's Section 2.
 *
 * A commit rather than a tag or a branch, because the offer is made to the person
 * holding this particular binary. Someone who installs this build and never
 * updates has to be able to get the source it was made from years later, after
 * main has moved on and after any tag that once pointed here could have been
 * moved or deleted. A commit URL is the only one of the three that cannot rot.
 *
 * Read out of git rather than passed in, because the working tree already is the
 * answer in both places this runs. pro/.github/workflows/publish-pro-desktop.yml
 * checks the public repository out at a commit it pinned once, and only then
 * checks the Pro module into pro/ beneath it — so at the root, origin is the
 * public repository and HEAD is that pinned commit. Passing either in would be a
 * second copy of a fact git is already holding, of the kind that drifts.
 *
 * A local build answers with its own HEAD, which is only true of the artifact if
 * that commit is pushed and the tree is clean. Neither is checked here: local Pro
 * builds are for testing the installer, and the run that publishes one is the CI
 * path above, where both hold by construction.
 *
 * PUBLIC_SOURCE_URL overrides the lot, for a build tree with no git in it.
 */
function correspondingSourceUrl() {
  if (process.env.PUBLIC_SOURCE_URL) return process.env.PUBLIC_SOURCE_URL;

  const git = (...args) => {
    const ran = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
    return ran.status === 0 ? ran.stdout.trim() : "";
  };

  // Both spellings a checkout can carry: https://github.com/owner/repo(.git) and
  // the scp-like git@github.com:owner/repo(.git) of one cloned over SSH. Host and
  // slug are read together rather than the slug alone, because owner/repo is not
  // a distinctive enough shape to identify a forge by: a GitLab or Gitea remote
  // matches it, and so does a plain clone path — C:/src/x/repo yields `x/repo` —
  // so the URL below would have been built confidently around whatever came out.
  const origin = git("remote", "get-url", "origin").replace(/\.git$/, "");
  const sha = git("rev-parse", "HEAD");
  const remote =
    /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(origin) ??
    /^(?:https?|git|ssh):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/.exec(origin);
  if (!remote || !sha || !/^[^/]+\/[^/]+$/.test(remote[2])) {
    throw new Error(
      "Could not resolve the Corresponding Source URL for the EULA: this tree has no git " +
        "origin and HEAD to read, and PUBLIC_SOURCE_URL is unset. Section 2 would ship " +
        "offering the source of a proprietary build at nothing in particular."
    );
  }
  const [, host, slug] = remote;
  // Refused rather than rewritten, because swapping the host in would not be
  // enough: `/tree/<sha>` is GitHub's spelling of a commit, where GitLab wants
  // `/-/tree/` and Gitea `/src/commit/`. Deriving the host alone would trade an
  // offer pointing at the wrong repository for one pointing at no page at all,
  // and both are the same failure as far as Section 2 is concerned.
  // PUBLIC_SOURCE_URL is the way in for every forge that is not this one.
  if (host !== "github.com") {
    throw new Error(
      `Could not resolve the Corresponding Source URL for the EULA: origin is on ${host}, ` +
        "and the commit URL built here is GitHub's own. Set PUBLIC_SOURCE_URL to the address " +
        "this build's source can actually be fetched from. Section 2 would otherwise ship " +
        "offering it at a github.com repository this build did not come from."
    );
  }
  return `https://github.com/${slug}/tree/${sha}`;
}

/**
 * pro/EULA.md rendered into one of the two formats an installer can show.
 *
 * Deliberately not a markdown library. The whole of what the EULA uses is ATX
 * headings, a blockquote, `**bold**`, ordered lists and one `---`, and a legal
 * document is the wrong place to hand rendering to a dependency that guesses:
 * what a parser quietly drops here is a term somebody is being asked to accept.
 * A construct this does not recognise comes out as its own source text, which is
 * visible in the installer — the right place for a rendering bug to surface.
 *
 * `**bold**` is the only inline construct, and it carries meaning rather than
 * decoration: Section 11's warranty disclaimer is bold in order to be
 * conspicuous, and the EULA's own draft notes turn on whether that is enough.
 * That is why the RTF exists at all, and why it is the copy given to the two
 * targets that put the document in front of a person.
 *
 * One function for both formats rather than two passes. Two would be two chances
 * for the plain text and the rich text to say different things, in the one
 * document where that matters.
 */
function renderEula(markdown, format) {
  // Checked rather than defaulted. `format === "rtf"` on its own sends every
  // other value down the plain-text path, and the caller writes that result to
  // EULA.rtf — where NSIS, which recognises RTF by the leading `{\rtf` and
  // nothing else, would show the agreement as its own raw source with Section
  // 11's bold disclaimer among the casualties. That is the one thing the RTF
  // rendering exists for, so a format this does not know is loud.
  if (format !== "rtf" && format !== "txt") {
    throw new Error(`renderEula was asked for an unknown format: ${JSON.stringify(format)}.`);
  }
  const rtf = format === "rtf";
  const WRAP = 78;
  const esc = rtf ? rtfEscape : (s) => s;

  // Split on the `**` runs rather than replacing them, so an unpaired marker
  // stays visible in the text instead of swallowing the rest of the paragraph.
  const inline = (text) =>
    text
      .split(/(\*\*[^*]+\*\*)/)
      .map((part) => {
        if (!/^\*\*[^*]+\*\*$/.test(part)) return esc(part);
        const inner = esc(part.slice(2, -2));
        return rtf ? `{\\b ${inner}}` : inner;
      })
      .join("");

  const out = [];

  // Belt and braces: `.gitattributes` checks pro/EULA.md out as LF on every
  // platform, so a CR should not reach here at all. It is worth the line anyway
  // because what it prevents is silent and total rather than cosmetic — a CRLF
  // document holds no `\n\n`, so the whole agreement would arrive as a single
  // block, every line would keep a trailing CR, and no heading would match
  // (`.` does not match `\r`). The installer would show one 18,000-character
  // paragraph with no headings, no lists and no bold, and the build would
  // report success.
  const source = markdown.replace(/\r\n?/g, "\n");

  for (const block of source.split(/\n{2,}/)) {
    let lines = block.split("\n").filter((line) => line.trim() !== "");

    // Peeled off first, and the block carries on afterwards rather than ending:
    // a heading is its own block throughout this file, and if one ever acquires
    // a paragraph glued to it, both should render instead of one going missing.
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(lines[0] ?? "");
    if (heading) {
      const text = inline(heading[2]);
      const title = heading[1].length === 1;
      if (rtf) {
        out.push(
          title
            ? `\\pard\\qc\\sa240{\\b\\fs32 ${text}}\\par`
            : `\\pard\\sb240\\sa120{\\b\\fs24 ${text}}\\par`
        );
      } else {
        // Ruled, because plain text has no weight to switch on and the EULA
        // numbers its own sections in the heading text. Unruled, `## 4.
        // Restrictions` and clause 4 *of* that section are the same two
        // characters at the same margin twenty lines apart, in a document that
        // cites both by number \u2014 "Except as Section 2 permits", "in violation
        // of ... Section 6". The RTF tells them apart with \\fs24 and bold; this
        // is the plain-text half of the same distinction, and the one target
        // reading it is the AppImage, whose copy is filed away to be re-read
        // rather than clicked through.
        //
        // `=` under the title and `-` under a section, each as wide as the
        // longest line above it \u2014 never the full width, which is what the `---`
        // rule renders as.
        const rows = wrap(text, WRAP);
        const rule = (title ? "=" : "-").repeat(Math.max(1, ...rows.map((row) => row.length)));
        out.push([...rows, rule].join("\n"));
      }
      lines = lines.slice(1);
    }

    if (/^-{3,}$/.test(lines[0] ?? "")) {
      out.push(rtf ? "\\pard\\brdrb\\brdrs\\brdrw10\\brsp20\\sa240\\par" : "-".repeat(WRAP));
      lines = lines.slice(1);
    }

    if (lines.length === 0) continue;

    // The blockquote is the draft banner, and the marker comes off every line.
    if (lines.every((line) => /^>\s?/.test(line))) {
      const text = inline(lines.map((line) => line.replace(/^>\s?/, "")).join(" "));
      out.push(
        rtf
          ? `\\pard\\li360\\ri360\\sa240 ${text}\\par`
          : wrap(text, WRAP - 4)
              .map((line) => `    ${line}`)
              .join("\n")
      );
      continue;
    }

    // Ordered lists: `1. ` opens an item, and a line that opens no item
    // continues the one before it — which is how the numbered restrictions in
    // Sections 3 and 4 wrap. The number is carried through rather than
    // recounted, because the EULA cites its own clauses by number.
    if (/^\d+\.\s/.test(lines[0])) {
      const items = [];
      for (const line of lines) {
        const opened = /^(\d+)\.\s+(.*)$/.exec(line);
        if (opened) items.push({ n: opened[1], text: opened[2] });
        else items[items.length - 1].text += ` ${line.trim()}`;
      }
      for (const { n, text } of items) {
        out.push(
          rtf
            ? `\\pard\\fi-360\\li360\\sa120 ${n}.\\tab ${inline(text)}\\par`
            : wrap(`${n}. ${inline(text)}`, WRAP, 3).join("\n")
        );
      }
      continue;
    }

    const text = inline(lines.join(" "));
    out.push(rtf ? `\\pard\\sa240 ${text}\\par` : wrap(text, WRAP).join("\n"));
  }

  // A blank line between blocks in plain text; in RTF the spacing is the `\sa`
  // on each paragraph, so the newlines there only keep the file readable.
  if (!rtf) return `${out.join("\n\n")}\n`;

  // `\fs` is half-points: 10pt body, 16pt title, 12pt section headings. Segoe UI
  // is the Windows installer's own font, and the macOS SLA substitutes its own
  // when it is missing — the right way round, since the NSIS page is the one
  // somebody actually reads at length.
  return (
    "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss\\fcharset0 Segoe UI;}}\n" +
    "\\fs20\n" +
    `${out.join("\n")}\n}\n`
  );
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

  // The same failure one file over, and it needs its own removal because these
  // sit beside bundle/node_modules rather than inside it. `files: ["bundle/**"]`
  // packs the whole directory, so a copy left by an earlier Pro build would ride
  // inside a free installer — and the `license` keys in the packaging config,
  // which are off on a free build, are not what would have stopped it.
  for (const stale of Object.values(eulaOut)) fs.rmSync(stale, { force: true });

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

  // Both formats, because the three installer targets do not agree on one: NSIS
  // and the dmg read the RTF, the AppImage takes plain text and nothing else.
  // Which target gets which is set in electron-builder.config.cjs, and only on a
  // Pro build — the agreement covers a build that includes the Pro Module, and
  // the free build is AGPL.
  if (!fs.existsSync(proEula)) {
    throw new Error(
      `${proEula} is missing. It is what a Pro installer asks the user to accept, so a ` +
        "build without it would install the Pro Module having agreed nothing at all."
    );
  }
  const source = fs.readFileSync(proEula, "utf8");
  // Asserted rather than assumed. Substitution that silently matches nothing is
  // how the shipped agreement ends up making no Corresponding Source offer at
  // all — an edit to Section 2 that reworded the token away would otherwise
  // produce a clean build and an installer that quietly stopped complying.
  if (!source.includes(SOURCE_URL_TOKEN)) {
    throw new Error(
      `${proEula} no longer contains ${SOURCE_URL_TOKEN}. That token is where Section 2 ` +
        "offers the source this build was made from, and the AGPL portions of a Pro " +
        "installer cannot be distributed without it."
    );
  }
  const eula = source.replaceAll(SOURCE_URL_TOKEN, correspondingSourceUrl());
  fs.writeFileSync(eulaOut.rtf, renderEula(eula, "rtf"));
  fs.writeFileSync(eulaOut.txt, renderEula(eula, "txt"));
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
