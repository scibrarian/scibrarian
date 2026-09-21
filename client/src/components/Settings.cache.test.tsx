// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Settings } from "./Settings";
import type { AppSettings } from "../types";

afterEach(cleanup);

// The "Cached copies" section, and what it does when it cannot read the cache.
//
// The section is drawn on settings.desktop rather than on that reading, so a
// failed fetch is not the same thing as an empty cache — and spelling them the
// same left the panel showing no size beside a button disabled for good, which
// the reader could neither press nor account for.
//
// pro={null} so ProPanel never mounts: it fetches on its own and has nothing to
// do with any of this.
const api = vi.hoisted(() => ({
  getJournals: vi.fn(),
  getTopics: vi.fn(),
  getSettings: vi.fn(),
  suggestTopics: vi.fn(),
  cacheStats: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

const DESKTOP: AppSettings = {
  ncbi_email: "reader@example.com",
  poll_cron: "0 6 * * *",
  poll_enabled: false,
  library_open: false,
  has_api_key: false,
  share_urls: [],
  desktop: true,
};

function renderSettings() {
  api.getJournals.mockResolvedValue([]);
  api.getTopics.mockResolvedValue([]);
  api.getSettings.mockResolvedValue(DESKTOP);
  api.suggestTopics.mockResolvedValue({ results: [], heldPapers: 0, unchecked: 0 });
  return render(
    <Settings
      pro={null}
      onDataChanged={() => {}}
      onPairingChanged={() => {}}
      onSharingChanged={() => {}}
      onPapersRemoved={() => {}}
      onLibraryReset={() => {}}
    />
  );
}

const clearButton = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /clear cached copies/i });

describe("the cached copies section when the reading fails", () => {
  it("says so, and leaves the button pressable", async () => {
    api.cacheStats.mockRejectedValue(new Error("network"));
    renderSettings();

    await waitFor(() => expect(screen.getByText(/could not be read just now/i)).toBeTruthy());
    // Pressing it is how the reader finds out what is there, since clearing
    // reports what it did. Disabled here was a dead end with no way out of it.
    expect(clearButton().disabled).toBe(false);
    // And no size claimed that nothing supports.
    expect(screen.queryByText(/Currently/)).toBeNull();
    expect(screen.queryByText(/Nothing is cached right now/)).toBeNull();
  });

  it("says nothing is cached, and disables the button, when the reading is zero", async () => {
    api.cacheStats.mockResolvedValue({ files: 0, bytes: 0, unsaved: 0 });
    renderSettings();

    await waitFor(() => expect(screen.getByText(/Nothing is cached right now/)).toBeTruthy());
    expect(clearButton().disabled).toBe(true);
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("warns about copies whose changes are not in the library", async () => {
    api.cacheStats.mockResolvedValue({ files: 3, bytes: 2048, unsaved: 1 });
    renderSettings();

    await waitFor(() => expect(screen.getByText(/changes that are not in the library/)).toBeTruthy());
    expect(clearButton().disabled).toBe(false);
  });
});
