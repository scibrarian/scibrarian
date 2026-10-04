// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Settings } from "./Settings";
import { ClearCacheDialog } from "./CacheChip";
import { useViewerCache } from "../lib/viewerCache";
import type { AppSettings } from "../types";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
  getSettings: vi.fn(),
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

// The reading and the clear are the shell's, handed down, so this stands in for
// the shell: the same hook App calls, and the confirmation it renders beside
// the panel. Real ones rather than a stubbed ViewerCache, because what these
// tests pin is what the panel does with a request that failed or a clear that
// was confirmed — and a stub would be asserting against itself.
function Shell() {
  const viewerCache = useViewerCache(true);
  return (
    <>
      <Settings
        pro={null}
        viewerCache={viewerCache}
        topics={[]}
        topicsError={null}
        onAddTopic={() => {}}
        onEditTopic={() => {}}
        onDataChanged={() => {}}
        onPairingChanged={() => {}}
        onSharingChanged={() => {}}
        onPapersRemoved={() => {}}
        onLibraryReset={() => {}}
      />
      <ClearCacheDialog viewerCache={viewerCache} />
    </>
  );
}

function renderSettings() {
  api.getSettings.mockResolvedValue(DESKTOP);
  return render(<Shell />);
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
    // Waited for, as pressClear does: the sentence is drawn the moment the
    // reading fails, and the button comes on with the rest of the page, a
    // commit later (see useReveal). Asked at once, it was now and then still off.
    await waitFor(() => expect(clearButton().disabled).toBe(false));
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
    await waitFor(() => expect(clearButton().disabled).toBe(false));
  });
});

// The button used to clear on the press. It asks now, because a paper still
// open in a viewer is the one thing the clear cannot check for itself.
describe("clearing from the cached copies section", () => {
  const QUESTION = "Confirm all of your library papers are closed before continuing.";

  async function pressClear() {
    await waitFor(() => expect(clearButton().disabled).toBe(false));
    fireEvent.click(clearButton());
  }

  it("asks first, and Cancel deletes nothing", async () => {
    api.cacheStats.mockResolvedValue({ files: 3, bytes: 2048, unsaved: 0 });
    renderSettings();
    await pressClear();

    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(api.clearCache).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText(QUESTION)).toBeNull());
    expect(api.clearCache).not.toHaveBeenCalled();
    // Nothing happened, so there is nothing for the panel to report.
    expect(screen.queryByText(/Cleared/)).toBeNull();
  });

  it("clears on Proceed and reports under its own button", async () => {
    api.cacheStats
      .mockResolvedValueOnce({ files: 3, bytes: 2048, unsaved: 0 })
      // Settings asks again on mount; both of those come before the clear.
      .mockResolvedValueOnce({ files: 3, bytes: 2048, unsaved: 0 })
      .mockResolvedValue({ files: 0, bytes: 0, unsaved: 0 });
    api.clearCache.mockResolvedValue({ files: 3, bytes: 2048, unsaved: 0, blocked: 0 });
    renderSettings();
    await pressClear();

    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));

    await waitFor(() =>
      expect(screen.getByText("Cleared 3 cached files, freeing 2 KB.")).toBeTruthy()
    );
    expect(api.clearCache).toHaveBeenCalledTimes(1);
    // And the size beside it is the one read back afterwards.
    await waitFor(() => expect(screen.getByText(/Nothing is cached right now/)).toBeTruthy());
  });
});
