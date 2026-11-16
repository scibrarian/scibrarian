import { expect, it } from "vitest";

// The guard every test file runs under (test-network.ts). That it refuses the
// network is what every server test relies on; pinned here is what it leaves as
// the platform has it.

it("rejects a URL that doesn't parse, as fetch does, rather than throwing", async () => {
  let pending: Promise<Response> | undefined;
  expect(() => {
    pending = fetch("/api/settings");
  }).not.toThrow();
  await expect(pending).rejects.toThrow(TypeError);
});
