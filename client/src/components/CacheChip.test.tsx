// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CacheChip, ClearCacheDialog } from "./CacheChip";
import { CACHE_WARN_BYTES, useViewerCache } from "../lib/viewerCache";
import type { CacheStats } from "../types";

// The header's cache warning, with the hook and the confirmation it shares with
// Settings — the three are one behaviour, and the parts worth pinning are the
// ones that span them: when the warning is drawn at all, and that nothing is
// deleted until the reader has answered the dialog.
const api = vi.hoisted(() => ({
  cacheStats: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MB = 1024 * 1024;
const holding = (bytes: number, files = 47): CacheStats => ({ files, bytes, unsaved: 0 });
const EMPTY = holding(0, 0);

// What App does with them: one ViewerCache, handed to the chip and the dialog.
function Shell({
  enabled = true,
  onResult = () => {},
}: {
  enabled?: boolean;
  onResult?: (message: string) => void;
}) {
  const viewerCache = useViewerCache(enabled);
  return (
    <>
      <CacheChip viewerCache={viewerCache} onResult={onResult} />
      <ClearCacheDialog viewerCache={viewerCache} />
    </>
  );
}

// Let a mocked request and the state it sets land.
const settle = () => act(async () => {});

const chip = () => screen.queryByRole("button", { name: /cached/ });
const QUESTION = "Confirm all of your library papers are closed before continuing.";

describe("when the warning is drawn", () => {
  it("stays out of the way at exactly the limit", async () => {
    api.cacheStats.mockResolvedValue(holding(CACHE_WARN_BYTES));
    render(<Shell />);
    await settle();

    expect(api.cacheStats).toHaveBeenCalledTimes(1);
    expect(chip()).toBeNull();
  });

  it("appears one byte past it, with the size", async () => {
    api.cacheStats.mockResolvedValue(holding(CACHE_WARN_BYTES + 1));
    render(<Shell />);

    const button = await screen.findByRole("button", { name: /100 MB cached/ });
    // Named for what pressing it does, not only for what it reports.
    expect(button.textContent).toMatch(/Clear cached copies/);
  });

  it("asks nothing of a build that has no cache", async () => {
    render(<Shell enabled={false} />);
    await settle();

    // The route 404s off the desktop; not asking is the whole point of the flag.
    expect(api.cacheStats).not.toHaveBeenCalled();
    expect(chip()).toBeNull();
  });

  it("says nothing when the size could not be read", async () => {
    api.cacheStats.mockRejectedValue(new Error("network"));
    render(<Shell />);
    await settle();

    expect(chip()).toBeNull();
  });

  it("notices the cache has grown when the window comes back to the front", async () => {
    api.cacheStats.mockResolvedValueOnce(holding(38 * MB));
    render(<Shell />);
    await settle();
    expect(chip()).toBeNull();

    // A paper was opened and read in the viewer; nothing told this page.
    api.cacheStats.mockResolvedValue(holding(142 * MB));
    fireEvent.focus(window);

    expect(await screen.findByRole("button", { name: /142 MB cached/ })).toBeTruthy();
  });
});

describe("clearing from the warning", () => {
  it("asks first, and Cancel deletes nothing", async () => {
    api.cacheStats.mockResolvedValue(holding(142 * MB));
    const onResult = vi.fn();
    render(<Shell onResult={onResult} />);

    fireEvent.click(await screen.findByRole("button", { name: /142 MB cached/ }));
    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(api.clearCache).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();

    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(api.clearCache).not.toHaveBeenCalled();
    // Backing out is not an outcome to report, and the warning is still true.
    expect(onResult).not.toHaveBeenCalled();
    expect(chip()).not.toBeNull();
  });

  it("clears once on Proceed, reports it, and goes away", async () => {
    api.cacheStats.mockResolvedValueOnce(holding(142 * MB)).mockResolvedValue(EMPTY);
    api.clearCache.mockResolvedValue({ files: 47, bytes: 142 * MB, unsaved: 0, blocked: 0 });
    const onResult = vi.fn();
    render(<Shell onResult={onResult} />);

    fireEvent.click(await screen.findByRole("button", { name: /142 MB cached/ }));
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));

    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith("Cleared 47 cached files, freeing 142 MB.")
    );
    expect(api.clearCache).toHaveBeenCalledTimes(1);
    // The reading after the clear is what takes it down, not an assumption that
    // a clear always empties the cache.
    await waitFor(() => expect(chip()).toBeNull());
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it("stays, and says why, when a paper was still open", async () => {
    // Everything the clear could not remove is still over the limit.
    api.cacheStats.mockResolvedValueOnce(holding(260 * MB)).mockResolvedValue(holding(120 * MB, 2));
    api.clearCache.mockResolvedValue({ files: 45, bytes: 140 * MB, unsaved: 0, blocked: 2 });
    const onResult = vi.fn();
    render(<Shell onResult={onResult} />);

    fireEvent.click(await screen.findByRole("button", { name: /260 MB cached/ }));
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult.mock.calls[0][0]).toMatch(/2 cached files could not be removed/);
    // Still true, so still shown — and it is the way to try again.
    expect(await screen.findByRole("button", { name: /120 MB cached/ })).toBeTruthy();
  });

  it("reports a clear that failed, and keeps the warning", async () => {
    api.cacheStats.mockResolvedValue(holding(142 * MB));
    api.clearCache.mockRejectedValue(new Error("The disk said no."));
    const onResult = vi.fn();
    render(<Shell onResult={onResult} />);

    fireEvent.click(await screen.findByRole("button", { name: /142 MB cached/ }));
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith("The disk said no."));
    const button = chip() as HTMLButtonElement;
    expect(button).not.toBeNull();
    // Pressable again: a clear that failed is one worth retrying.
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});
