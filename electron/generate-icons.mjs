// Builds the app-icon set the packaging config expects — build/icon.png
// (1024x1024), build/icon.ico and build/icon.icns — plus the web client's
// favicon at ../client/public/favicon.png, all from one source image at
// build/icon-source.png.
//
// Why a script rather than electron-builder's own icon handling: the config
// names build/icon.ico and build/icon.icns explicitly (electron-builder.config
// .cjs, win.icon / mac.icon). electron-builder can synthesise those from a lone
// icon.png, but the .icns half of that needs iconutil, which is macOS-only —
// and this app is built and released from Windows and CI. png2icons writes both
// formats in pure JS on any platform, so the icons come out the same bytes
// wherever `npm run dist` runs.
//
// Why the source is a separate file from icon.png: the artwork arrives in
// whatever shape the designer handed over. icon.png must be a square 1024 for
// every downstream target, so it is a generated artefact, not something to
// hand-edit. To change the app icon, replace build/icon-source.png — that is
// the one file to touch — and the next `npm run pack` / `npm run dist` picks it
// up (both run this script first). `npm run generate-icons` runs it on its own.
//
//   node generate-icons.mjs [--source <path>] [--bg <css-color>] [--pad <0..0.4>]
//
// --bg defaults to transparent; pass e.g. --bg "#141d2e" for a filled tile.
// --pad is the margin left on each side as a fraction of the canvas (default 0,
// i.e. the source fills the square) — raise it for art that runs to its edges.
//
// The .icns gets a floor under that margin whatever --pad says, because macOS
// is the one platform with an opinion: every icon in the Dock sits on the same
// grid, inset from its canvas, so one that fills its square reads as oversized
// beside the rest. Windows and Linux have no such convention and their icons
// use the whole square, which is why this is applied to the icns alone rather
// than to the canvas all three are cut from.
//
// The favicon is cut from that same full-square canvas — the browser tab has no
// Dock grid to sit on, so it matches the Windows and Linux icons, not the Mac
// one. It is written into the client workspace because that is what serves it
// (vite copies client/public/ into the build verbatim), but it is generated
// here so that replacing build/icon-source.png stays the single move that
// changes every icon the app shows. Like the three above, the result is
// committed — the web build does not run this script.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Jimp from "jimp";
import png2icons from "png2icons";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, "build");
const faviconPath = path.join(here, "..", "client", "public", "favicon.png");
const SIZE = 1024;
// Big enough to stay crisp everywhere a favicon is scaled up — pinned tabs and
// bookmark bars pull it well past the 16-32px of the tab strip — while landing
// around 30 KB PNG-compressed rather than the ~45 KB a 256 costs.
const FAVICON = 192;
// Apple's icon grid puts a standard app icon in 824 of its 1024 points. A tenth
// of the canvas on each side lands within a few pixels of that.
const MAC_PAD = 0.1;

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sourcePath = path.resolve(flag("source", path.join(buildDir, "icon-source.png")));
const bg = flag("bg", "transparent");
const pad = Math.min(Math.max(Number.parseFloat(flag("pad", "0")), 0), 0.4);

if (!fs.existsSync(sourcePath)) {
  console.error(`generate-icons: no source image at ${sourcePath}`);
  process.exit(1);
}

const source = await Jimp.read(sourcePath);
const bgColor = bg === "transparent" ? 0x00000000 : Jimp.cssColorToHex(bg);

// Fit the source inside the padded square, keeping its aspect ratio, and centre
// it on a canvas of the chosen background. A portrait source simply ends up with
// transparent bars left and right — that is the source's problem to fix, not
// this script's.
//
// From the original every time rather than by re-padding an earlier canvas: the
// icns is inset further than the other two, and scaling art that has already
// been scaled once is a second resample for no reason.
function square(padding) {
  const art = source.clone();
  const content = Math.round(SIZE * (1 - padding * 2));
  art.scaleToFit(content, content);
  const canvas = new Jimp(SIZE, SIZE, bgColor);
  canvas.composite(
    art,
    Math.round((SIZE - art.bitmap.width) / 2),
    Math.round((SIZE - art.bitmap.height) / 2),
  );
  return canvas;
}

// A floor, not an addition: art that already needs --pad 0.2 does not want
// another tenth on top of it for the Mac.
const macPad = Math.max(pad, MAC_PAD);
const canvas = square(pad);
const macCanvas = square(macPad);

const iconPng = path.join(buildDir, "icon.png");
await canvas.writeAsync(iconPng);

// The favicon: the same 1024 canvas, resampled down once. BICUBIC to match the
// resampler png2icons uses for the .ico below, so the tab icon and the Windows
// icon are the same picture at different sizes.
await canvas.clone().resize(FAVICON, FAVICON, Jimp.RESIZE_BICUBIC).writeAsync(faviconPath);

// png2icons takes a PNG buffer and derives the whole size ladder itself.
// usePngCompression keeps the 256px frame in the .ico small (Windows reads
// PNG-compressed frames fine); the third arg 0 means "every standard size".
const png = await canvas.getBufferAsync(Jimp.MIME_PNG);
const macPng = await macCanvas.getBufferAsync(Jimp.MIME_PNG);

const ico = png2icons.createICO(png, png2icons.BICUBIC, 0, true, false);
if (!ico) throw new Error("generate-icons: ICO conversion returned nothing");
fs.writeFileSync(path.join(buildDir, "icon.ico"), ico);

const icns = png2icons.createICNS(macPng, png2icons.BICUBIC, 0);
if (!icns) throw new Error("generate-icons: ICNS conversion returned nothing");
fs.writeFileSync(path.join(buildDir, "icon.icns"), icns);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`generate-icons: from ${path.relative(here, sourcePath)}  (bg ${bg}, pad ${pad})`);
console.log(`  build/icon.png    ${SIZE}x${SIZE}   ${kb(fs.statSync(iconPng).size)}`);
console.log(`  build/icon.ico    ${kb(ico.length)}`);
console.log(`  build/icon.icns   ${kb(icns.length)}   (pad ${macPad}, Apple's grid)`);
console.log(
  `  client/public/favicon.png   ${FAVICON}x${FAVICON}   ${kb(fs.statSync(faviconPath).size)}`,
);
