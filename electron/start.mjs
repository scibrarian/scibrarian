// Launches the desktop app in development (`npm run desktop`).
//
// This exists to strip ELECTRON_RUN_AS_NODE from the environment first. VS
// Code is itself an Electron app and sets that variable for the processes it
// spawns — so a terminal inherited from the editor (or from an editor
// extension) silently turns `electron .` into "run this as plain Node". The
// failure is baffling when you hit it: Node loads main.mjs, resolves "electron"
// to the npm package whose export is the path string to the binary, and reports
// `does not provide an export named 'BrowserWindow'` — which reads like an
// ES-module interop bug and is nothing of the sort.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// Under Node, the electron package exports the path to its binary.
const electronBinary = createRequire(import.meta.url)("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ["."], { stdio: "inherit", env });

// A spawn that fails to launch emits 'error' asynchronously, and an 'error'
// with no listener is rethrown — so without this, the failure arrives as a bare
// Node stack trace rather than something actionable. The require above already
// covers a missing binary (it re-downloads, then throws with its own message),
// so what lands here is the case where the file exists but will not execute:
// antivirus quarantining or blocking the Electron binary on Windows, a noexec
// mount or lost +x on Linux, or ELECTRON_OVERRIDE_DIST_PATH aimed somewhere
// wrong — which that variable is returned from unchecked.
child.on("error", (err) => {
  console.error(`Could not launch Electron: ${err.message}`);
  console.error(`Tried: ${electronBinary}`);
  console.error("If that path looks wrong or the file is missing, run: npm install");
  process.exit(1);
});

child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
