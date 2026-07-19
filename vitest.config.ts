import { defineConfig } from "vitest/config";

// One runner for both workspaces. Tests live next to the code they cover and
// stick to pure logic (no DOM, no network, no database), so a plain node
// environment covers client and server alike.
export default defineConfig({
  test: {
    environment: "node",
    include: ["client/src/**/*.test.ts", "server/src/**/*.test.ts"],
  },
});
