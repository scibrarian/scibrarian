// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createSources, SourcesContext, useSources, type Sources, type SourcesApi } from "../lib/sources";
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
  alert_email_enabled: false,
  alert_email_to: "",
  smtp_host: "",
  smtp_port: "",
  smtp_user: "",
  smtp_from: "",
  has_smtp_pass: false,
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
  articleCount: 0,
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

let sources: Sources;

beforeEach(() => {
  vi.clearAllMocks();
  sources = createSources(api as unknown as SourcesApi);
  api.getSettings.mockResolvedValue(SAVED);
  api.topicArticleCount.mockResolvedValue({ count: 0 });
  api.deleteTopic.mockResolvedValue({ deletedArticles: 0 });
});

// The panel over the sources store, which reads the topics on mount as App's
// first load does: a read that fails leaves the list alone and says why.
function Shell() {
  return (
    <SourcesContext.Provider value={sources}>
      <Panel />
    </SourcesContext.Provider>
  );
}

function Panel() {
  const store = useSources();
  useEffect(() => void store.loadTopics(), [store]);
  return (
    <Settings
      pro={null}
      viewerCache={NO_CACHE}
      onAddTopic={() => {}}
      onEditTopic={() => {}}
      onPairingChanged={() => {}}
      onSharingChanged={() => {}}
      onPapersRemoved={() => {}}
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
