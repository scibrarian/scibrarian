// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { errorMessage } from "../lib/format";
import { Settings } from "./Settings";
import type { ViewerCache } from "../lib/viewerCache";
import type { AppSettings, Topic } from "../types";

afterEach(cleanup);

// What the Topics panel says when the topics couldn't be read.
//
// The list is the shell's, handed down, and the shell answers a failed read by
// leaving the list as it was. Settings listed that as the truth: "No topics
// yet." when nothing had been read at all, and after a removal whose re-read
// failed, the removed topic still there with its Edit and Remove. It reported
// both when the list was its own, and went quiet when it stopped being.
//
// pro={null} so ProPanel never mounts: it fetches on its own and has nothing to
// do with any of this.
const api = vi.hoisted(() => ({
  getTopics: vi.fn(),
  getSettings: vi.fn(),
  topicArticleCount: vi.fn(),
  deleteTopic: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

const SAVED: AppSettings = {
  ncbi_email: "",
  poll_cron: "0 6 * * *",
  poll_enabled: false,
  library_open: false,
  has_api_key: false,
  share_urls: [],
  desktop: false,
};

const TOPIC: Topic = {
  id: 7,
  name: "Sleep",
  term: '"Sleep"[MeSH]',
  headings: [{ ui: "D012890", name: "Sleep" }],
  all_pubmed: true,
  journalCount: 0,
  last_polled_at: null,
  created_at: "2026-10-01 00:00:00",
};

const NO_CACHE: ViewerCache = {
  cache: null,
  clearing: false,
  confirming: false,
  reload: () => {},
  requestClear: async () => null,
  proceed: () => {},
  cancel: () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue(SAVED);
  api.topicArticleCount.mockResolvedValue({ count: 0 });
  api.deleteTopic.mockResolvedValue({ deletedArticles: 0 });
});

// Stands in for the shell, reading the topics as App's loadTopics does: a read
// that fails leaves the list alone and says why.
function Shell() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicsError, setTopicsError] = useState<string | null>(null);
  const load = () =>
    void api.getTopics().then(
      (ts: Topic[]) => {
        setTopicsError(null);
        setTopics(ts);
      },
      (e: unknown) => setTopicsError(errorMessage(e))
    );
  useEffect(load, []);
  return (
    <Settings
      pro={null}
      viewerCache={NO_CACHE}
      topics={topics}
      topicsError={topicsError}
      onAddTopic={() => {}}
      onEditTopic={() => {}}
      onDataChanged={load}
      onPairingChanged={() => {}}
      onSharingChanged={() => {}}
      onPapersRemoved={() => {}}
      onLibraryReset={() => {}}
    />
  );
}

const failure = () => screen.findByText("Couldn’t load the topics: network");

describe("topics that couldn't be read", () => {
  it("are not reported as none", async () => {
    api.getTopics.mockRejectedValue(new Error("network"));
    render(<Shell />);
    await failure();
    expect(screen.queryByText("No topics yet.")).toBeNull();
  });

  it("are read again when asked", async () => {
    api.getTopics.mockRejectedValueOnce(new Error("network")).mockResolvedValue([TOPIC]);
    render(<Shell />);
    await failure();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Sleep");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("say so after a removal, where the removed topic is still listed", async () => {
    api.getTopics
      .mockResolvedValueOnce([TOPIC])
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue([]);
    render(<Shell />);
    await screen.findByText("Sleep");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByText('Remove "Sleep"?');
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    // Removed, and the list is the one from before: nothing newer was read.
    await failure();
    expect(api.deleteTopic).toHaveBeenCalledWith(7);
    expect(screen.getByText("Sleep")).toBeTruthy();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No topics yet.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
