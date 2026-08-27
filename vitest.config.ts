import { defineConfig } from "vitest/config";

// One runner for both workspaces. Tests live next to the code they cover, and
// the default here is what most of them want: a plain node environment, no DOM
// and no network. Most are pure-function tests; the few that can't be open a
// real SQLite file under a temp directory (see server/src/test-db.ts), which
// relies on vitest isolating the module graph per test file so each gets its
// own.
//
// Component tests ask for a DOM themselves, with a `@vitest-environment jsdom`
// docblock on the first line of the file. Per-file rather than a second project
// configured here: they are the minority, an environment named where it is used
// is one less thing to go and look up, and a node default keeps the server
// suite from standing up a DOM it never touches.
export default defineConfig({
  test: {
    environment: "node",
    // pro/ is a private workspace that is absent from a public checkout, where
    // this glob simply matches nothing. Listing it here rather than in a second
    // config keeps one `npm test` covering whichever halves are present.
    include: [
      "client/src/**/*.test.{ts,tsx}",
      "server/src/**/*.test.ts",
      "pro/src/**/*.test.ts",
    ],
  },
});
