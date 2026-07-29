// Code-signing configuration for the desktop build — a template you fill in
// once. DESKTOP.md § Signing covers what to buy and from whom; this file is
// where the non-secret half of it lands.
//
// Two properties make it safe to keep in a public repository:
//
//   1. No secret lives here. Certificates, passwords and API keys are read from
//      the environment by electron-builder itself. Locally they come from
//      `.env.signing` at the repo root (gitignored — copy `.env.signing.example`);
//      in CI they come from repository secrets.
//   2. Signing switches itself on when those credentials appear and stays off
//      when they don't. A local `npm run desktop:dist` is therefore unsigned
//      without anyone opting out, and a fork with no secrets still gets
//      installers out of CI instead of a red build.
//
// What remains below is the one thing electron-builder wants as *config* rather
// than environment: the Azure Trusted Signing account. It names an account, not
// a key, so it isn't sensitive — but it has to match your Azure resources
// exactly or signing fails deep inside PowerShell with an opaque error.
const fs = require("node:fs");
const path = require("node:path");

// Every signing variable electron-builder reads, ours or its own. Blank ones are
// deleted rather than ignored, because "empty means unset" has to be true for
// electron-builder and not just for this file: an unset GitHub secret
// interpolates to "", so `CSC_LINK: ${{ secrets.CSC_LINK }}` on a repo with no
// certificate arrives defined-but-empty — and electron-builder's macOS path
// tests `cscLink == null`, not emptiness (platformPackager.getCscLink, then
// macPackager). It resolves "" against the project directory, finds a directory
// where it wanted a .p12, and kills the build with `<projectDir> not a file`.
// The Windows path guards `=== ""` explicitly; the macOS one does not. Same
// treatment fixes a variable left blank in .env.signing.
const SIGNING_VARS = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "CSC_INSTALLER_LINK",
  "CSC_INSTALLER_KEY_PASSWORD",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_USERNAME",
  "AZURE_PASSWORD",
  "AZURE_PUBLISHER_NAME",
  "AZURE_ENDPOINT",
  "AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "AZURE_CERTIFICATE_PROFILE_NAME",
];

const dropBlankSigningVars = () => {
  for (const name of SIGNING_VARS) {
    const value = process.env[name];
    if (value != null && value.trim() === "") {
      delete process.env[name];
    }
  }
};

// Before and after loading the file, for different reasons: before, so an empty
// CI variable doesn't win the "already set wins" contest below and shadow a real
// value; after, because a blank `CSC_LINK=` line in the file sets one too.
dropBlankSigningVars();

// Parsed here rather than with `require("dotenv")`, which this file has no claim
// on. dotenv sits in electron/package.json only because the server happens to
// use it at runtime, and build.mjs's drift check deletes anything there that the
// server drops — so the day the server moves to `node --env-file`, packaging
// would start dying on a missing module for reasons nobody would connect back to
// signing. A build-time need that nothing declares is worth fifteen lines to
// remove.
//
// Deliberately narrower than dotenv in one respect: an unquoted `#` is kept
// rather than read as an inline comment. This file holds passwords, and
// truncating one at a `#` is a worse failure than a comment that doesn't work.
function parseEnvFile(contents) {
  const values = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Matching surrounding quotes come off, so a path with spaces can be quoted.
    const quote = value[0];
    if (value.length > 1 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

// Local convenience, so signing a build is `npm run desktop:dist` and not a
// paragraph of `set`/`export` first. A variable already in the environment wins,
// which keeps CI's real secrets ahead of a stale file that somehow got onto a
// runner.
const envFile = path.join(__dirname, "..", ".env.signing");
if (fs.existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(envFile, "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

dropBlankSigningVars();

// ─── REPLACE ME ──────────────────────────────────────────────────────────────
// Azure Trusted Signing account details, used only when the AZURE_* credentials
// below are set. Either edit these values or set the env var named beside each
// one — the env var wins, which is how CI supplies them without a commit.
const AZURE_TRUSTED_SIGNING = {
  // Exactly as it appears in the certificate subject, `CN=` and all. A mismatch
  // here does not fail the build; it produces a signature Windows won't trust.
  // env: AZURE_PUBLISHER_NAME
  publisherName: "CN=REPLACE_ME",

  // Regional endpoint of your Trusted Signing account — it must be the region
  // the account and certificate profile were created in, e.g.
  // https://wus2.codesigning.azure.net for West US 2.
  // env: AZURE_ENDPOINT
  endpoint: "https://REPLACE_ME.codesigning.azure.net",

  // env: AZURE_CODE_SIGNING_ACCOUNT_NAME
  codeSigningAccountName: "REPLACE_ME",

  // env: AZURE_CERTIFICATE_PROFILE_NAME
  certificateProfileName: "REPLACE_ME",
};
// ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER = /REPLACE_ME/;

// Empty-string and whitespace count as unset — the same rule dropBlankSigningVars
// applies above, kept here for anything outside that list. Treating blank as
// absent is what lets one workflow serve both a configured repo and a fork.
const env = (name) => {
  const value = process.env[name];
  return value != null && value.trim() !== "" ? value.trim() : undefined;
};

// Which platforms this run is actually packaging, by electron-builder's own
// rule (its CLI, builder.js): each of --mac / --win / --linux and their aliases
// adds one, and if none is given it builds for the host platform alone. Short
// flags group, so `-mwl` is all three.
//
// This is only ever used to decide whether a misconfiguration is fatal, never
// what gets signed, which keeps the cost of being wrong bounded — see scoped()
// below.
const PLATFORM_FLAGS = {
  macos: { long: ["--mac", "--macos", "--osx"], short: ["m", "o"] },
  windows: { long: ["--win", "--windows"], short: ["w"] },
  linux: { long: ["--linux"], short: ["l"] },
};

function requestedPlatforms() {
  const requested = new Set();

  for (const arg of process.argv.slice(2)) {
    for (const [platform, { long, short }] of Object.entries(PLATFORM_FLAGS)) {
      if (arg.startsWith("--")) {
        // `--win nsis` and `--win=nsis` both name a platform.
        if (long.includes(arg.split("=")[0])) requested.add(platform);
      } else if (/^-[a-z]+$/.test(arg)) {
        if (short.some((letter) => arg.slice(1).includes(letter))) requested.add(platform);
      }
    }
  }

  if (requested.size > 0) return requested;
  return new Set([{ win32: "windows", darwin: "macos" }[process.platform] ?? "linux"]);
}

const BUILDING = requestedPlatforms();

// windows() and macos() both run on every build, because a config module has no
// way to ask electron-builder what it is about to package. That costs nothing
// for the *values* — electron-builder reads `win` only when it builds Windows —
// but it is wrong for the *errors*. Left alone, a half-filled Azure block aborts
// a macOS build and a half-configured notarization set aborts a Windows one,
// over configuration that build would never have read. The AZURE_* names make
// that worse than it sounds: they are Azure's standard EnvironmentCredential
// variables, so a shell set up for the Azure CLI or Terraform can carry them
// with no intent to sign anything.
//
// So the checks always run and only their fatality is scoped. Note which way
// this fails: if requestedPlatforms() is wrong, an error becomes a warning and
// electron-builder goes on to fail on its own further in — which is exactly
// where this file left things before these guards existed. It cannot turn a
// signed build into an unsigned one, because the config is unchanged either way.
function scoped(platform, compute) {
  try {
    return compute();
  } catch (error) {
    if (BUILDING.has(platform)) throw error;
    console.warn(
      `[signing] not building for ${platform}, so this is a warning rather than an error:\n${error.message}`
    );
    // `mode` goes unread: the summary at the bottom prints only platforms in
    // BUILDING, and reaching here means this one isn't. Empty config rather than
    // a partial one, so a half-configured platform contributes nothing at all.
    return { mode: "misconfigured, and not being built", config: {} };
  }
}

// Both platforms below authenticate by "one of these credential sets is in the
// environment", and both fail the same way when a set is one variable short: it
// reads as "not configured", and "not configured" quietly ships an unsigned or
// un-notarized artifact. So the choice runs through here for both.
//
// `triggers` are the variables that mean "I am trying to authenticate this way";
// `needs` is everything that method then requires. Methods are tried in order,
// and the first one triggered is answered for — a half-configured set is an
// error rather than a shrug, because the shrug is what ships the bad artifact.
function selectMethod(methods, subject, hint) {
  for (const method of methods) {
    if (!method.triggers.some((name) => env(name) !== undefined)) {
      continue;
    }

    const missing = method.needs.filter((name) => env(name) === undefined);
    if (missing.length === 0) {
      return method.label;
    }

    throw new Error(
      `${subject} is half-configured. ${method.label} needs ` +
        `${method.needs.join(", ")}, but ` +
        `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.\n` +
        `${hint}\n` +
        "See .env.signing.example and DESKTOP.md § Signing."
    );
  }

  return undefined;
}

// Azure Trusted Signing has no credentials of its own. electron-builder shells
// out to PowerShell's `Invoke-TrustedSigning`, which authenticates through
// Azure's EnvironmentCredential — windowsSignAzureManager.js says as much and
// links the docs. So "are we signing?" really means "will EnvironmentCredential
// find a service principal?", and it accepts three shapes, not just the client
// secret. Recognising only one of them is silent: a build with working
// certificate credentials emits no azureSignOptions, winPackager picks the
// signtool manager instead, and an unsigned installer ships under a
// `[signing] windows: unsigned` line nobody reads in a ten-minute log.
//
// AZURE_TENANT_ID and AZURE_CLIENT_ID deliberately trigger nothing on their own.
// They are ordinary furniture in a shell set up for the Azure CLI or Terraform,
// and by themselves they are not an attempt to sign anything.
const AZURE_CREDENTIAL_METHODS = [
  {
    label: "client secret",
    triggers: ["AZURE_CLIENT_SECRET"],
    needs: ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"],
  },
  {
    label: "client certificate",
    triggers: ["AZURE_CLIENT_CERTIFICATE_PATH"],
    needs: ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_CERTIFICATE_PATH"],
  },
  {
    label: "username and password",
    triggers: ["AZURE_USERNAME", "AZURE_PASSWORD"],
    needs: ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_USERNAME", "AZURE_PASSWORD"],
  },
];

const azureCredentialMethod = () =>
  selectMethod(
    AZURE_CREDENTIAL_METHODS,
    "Azure Trusted Signing",
    "Set the missing variable(s), or unset the rest to build unsigned."
  );

function azureSignOptions() {
  const resolved = {
    publisherName: env("AZURE_PUBLISHER_NAME") ?? AZURE_TRUSTED_SIGNING.publisherName,
    endpoint: env("AZURE_ENDPOINT") ?? AZURE_TRUSTED_SIGNING.endpoint,
    codeSigningAccountName:
      env("AZURE_CODE_SIGNING_ACCOUNT_NAME") ?? AZURE_TRUSTED_SIGNING.codeSigningAccountName,
    certificateProfileName:
      env("AZURE_CERTIFICATE_PROFILE_NAME") ?? AZURE_TRUSTED_SIGNING.certificateProfileName,
  };

  // Credentials without account details is the one combination worth stopping
  // for. You clearly meant to sign, and the alternative is a ten-minute build
  // that dies in `Invoke-TrustedSigning` with an Azure error naming none of this.
  //
  // Blank counts as unfilled, not just the REPLACE_ME text. Clearing a field to
  // come back to it later is the ordinary way to half-finish this block, and an
  // empty string sails past a placeholder check straight into the opaque
  // PowerShell failure the check exists to prevent — signFile drops options that
  // are null, but not ones that are "".
  //
  // publisherName is exempt when absent: electron-builder reads a null there as
  // "don't set one" (windowsSignAzureManager), so it is a real choice. The other
  // three have no such reading, and a missing one is simply broken.
  const OPTIONAL = ["publisherName"];
  const unfilled = Object.entries(resolved)
    .filter(([key, value]) => {
      if (typeof value === "string") return value.trim() === "" || PLACEHOLDER.test(value);
      return value == null && !OPTIONAL.includes(key);
    })
    .map(([key]) => key);
  if (unfilled.length > 0) {
    throw new Error(
      "Azure Trusted Signing credentials are set, but these account details are\n" +
        "still placeholders, blank or missing:\n" +
        unfilled.map((key) => `  - ${key}`).join("\n") +
        "\nFill them in at the REPLACE ME block in electron/signing.config.cjs, or set the\n" +
        "matching AZURE_* variables (see .env.signing.example). To build unsigned instead,\n" +
        "unset whichever credential selected Azure signing — AZURE_CLIENT_SECRET,\n" +
        "AZURE_CLIENT_CERTIFICATE_PATH, or AZURE_USERNAME / AZURE_PASSWORD."
    );
  }
  return resolved;
}

// Windows: unsigned installers run, but every download shows a SmartScreen
// warning the user has to click past.
function windows() {
  const azure = azureCredentialMethod();
  const certFile = env("WIN_CSC_LINK") ?? env("CSC_LINK");

  // Same scoping as scoped() applies to errors, and for the same reason: this
  // function runs on every build, and a Windows remark on a macOS build is
  // noise about an artifact that isn't being made. The CSC_LINK warning below
  // would otherwise fire for every Mac user who set CSC_LINK — which is the
  // documented, correct way to configure macOS signing.
  const warn = (message) => {
    if (BUILDING.has("windows")) console.warn(message);
  };

  if (azure) {
    if (certFile) {
      // electron-builder rejects both at once and falls back to Azure. Say so
      // rather than let the .pfx you thought you were using go unmentioned.
      warn(
        "[signing] both Azure credentials and a certificate file are set — using Azure Trusted Signing"
      );
    }
    const options = azureSignOptions();
    return {
      mode:
        `Azure Trusted Signing via ${azure} ` +
        `(account ${options.codeSigningAccountName}, profile ${options.certificateProfileName})`,
      config: { azureSignOptions: options },
    };
  }

  if (certFile) {
    if (env("WIN_CSC_LINK") === undefined) {
      // Falling back to the unprefixed variable, which macOS uses for its
      // Developer ID .p12 — and .env.signing is read on every platform, so the
      // one a Mac user filled in is sitting right here. signtool would either
      // fail on it or produce a signature Windows will not trust, after a build
      // that logged "certificate file" as though all were well.
      warn(
        "[signing] windows: no WIN_CSC_LINK, falling back to the unprefixed CSC_LINK.\n" +
          "          That variable is shared with macOS — if it holds a Developer ID .p12,\n" +
          "          set WIN_CSC_LINK to the .pfx instead and keep the two apart."
      );
    }
    // Nothing else to configure: electron-builder reads CSC_LINK /
    // CSC_KEY_PASSWORD (or the WIN_-prefixed pair) on its own. Only pre-2023 OV
    // certificates can be used this way — see DESKTOP.md.
    return { mode: "certificate file", config: {} };
  }

  return { mode: "unsigned", config: {} };
}

// The three ways notarytool can authenticate, in the order electron-builder
// tries them (MacTargetHelper.getNotarizeOptions) — Apple ID first, then the
// App Store Connect key, then a keychain profile. `triggers` is what makes it
// pick a method, `needs` is what that method then requires: electron-builder
// enters the Apple ID branch on APPLE_ID *or* the password alone and only then
// demands the team id, which is why the two lists differ.
const NOTARIZATION_METHODS = [
  {
    label: "Apple ID",
    triggers: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"],
    needs: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
  },
  {
    label: "App Store Connect API key",
    triggers: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    needs: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
  },
  {
    label: "keychain profile",
    triggers: ["APPLE_KEYCHAIN_PROFILE"],
    needs: ["APPLE_KEYCHAIN_PROFILE"],
  },
];

// Half a set throwing matters more here than anywhere else in this file: the
// caller below would otherwise read "no notarization" and set `notarize: false`,
// which electron-builder honours as a deliberate opt-out and logs at info level.
// A signed-but-un-notarized dmg then ships, and Gatekeeper refuses it on every
// user's Mac. One mistyped secret name is enough.
const notarizationMethod = () =>
  selectMethod(
    NOTARIZATION_METHODS,
    "macOS notarization",
    "Set the missing variable(s), or unset the rest to build without notarization."
  );

// macOS: Gatekeeper refuses an unsigned app downloaded from the internet
// outright, so for distribution both halves below have to be real.
function macos() {
  const notarization = notarizationMethod();

  // Whether the app gets *signed* is not ours to report: beyond CSC_LINK and
  // CSC_NAME, electron-builder will find a Developer ID sitting in the local
  // keychain unless CSC_IDENTITY_AUTO_DISCOVERY=false. It logs what it picked.
  const certificate = env("CSC_LINK")
    ? "certificate file"
    : env("CSC_NAME")
      ? "named identity"
      : "keychain auto-discovery";

  if (!notarization) {
    // Reached only when no notarization variable is set at all — a partial set
    // threw above rather than arriving here as a false. In electron-builder 26
    // notarization is opt-*out*: it runs whenever the credentials are in the
    // environment, and otherwise logs a warning about options it "was unable to
    // generate". Setting it false turns that warning into a deliberate skip.
    return { mode: `${certificate}, not notarized`, config: { notarize: false } };
  }

  // Deliberately empty. There is no `notarize: true` to set — passing the
  // credentials is the switch, and hardenedRuntime (required by notarization)
  // is already on in electron-builder.config.cjs.
  return { mode: `${certificate}, notarized via ${notarization}`, config: {} };
}

const win = scoped("windows", windows);
const mac = scoped("macos", macos);

// One line per platform being built, saying what happened — the failure this
// guards against is a release you believe is signed and isn't, and DESKTOP.md
// points at these lines as the check against it.
//
// Keyed on what is being built, not on the host that is building it. Those are
// not the same thing: `electron-builder --linux` on a Mac used to print macOS
// signing status for a dmg this run never produced, and a `-mwl` build reported
// one platform out of three. A line describing an artifact that does not exist
// is worse than no line, because this is the one output you are told to trust.
const SUMMARY = {
  windows: `windows: ${win.mode}`,
  macos: `macos: ${mac.mode}`,
  linux: "linux: AppImages are conventionally distributed unsigned",
};

for (const [platform, line] of Object.entries(SUMMARY)) {
  if (BUILDING.has(platform)) {
    console.log(`[signing] ${line}`);
  }
}

module.exports = { win: win.config, mac: mac.config };
