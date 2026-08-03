import { defineConfig } from "vitest/config";

// One runner for both workspaces. Tests live next to the code they cover and
// touch neither DOM nor network, so a plain node environment covers client and
// server alike. Most are pure-function tests; the few that can't be open a real
// SQLite file under a temp directory (see server/src/test-db.ts), which relies
// on vitest isolating the module graph per test file so each gets its own.
export default defineConfig({
  test: {
    environment: "node",
    include: ["client/src/**/*.test.ts", "server/src/**/*.test.ts"],
  },
});
