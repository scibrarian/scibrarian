// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Settings } from "./Settings";
import type { AppSettings, Topic, TopicDetail } from "../types";

afterEach(cleanup);

// What the Polling & NCBI form keeps while it holds edits not yet saved.
//
// The form is saved by its own button, and the Topics panel above it changes
// things on its own: a topic saved or removed sends the panel back for its
// list. That used to be the reload the page opens with, which fetches the
// settings as well and put the server's copy back over the form — an address
// typed and not yet saved was gone, and the button that would have saved it
// went grey with it.
//
// pro={null} so ProPanel never mounts: it fetches on its own and has nothing to
// do with any of this.
const api = vi.hoisted(() => ({
  getTopics: vi.fn(),
  getSettings: vi.fn(),
  getTopic: vi.fn(),
  updateTopic: vi.fn(),
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
const RENAMED: Topic = { ...TOPIC, name: "Rest" };

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue(SAVED);
  api.getTopic.mockResolvedValue({ ...TOPIC, journals: [] } satisfies TopicDetail);
  api.updateTopic.mockResolvedValue({
    topic: { ...RENAMED, journals: [] },
    removed: { deletedArticles: 0, removedFromInterests: 0 },
  });
  api.topicArticleCount.mockResolvedValue({ count: 0 });
  api.deleteTopic.mockResolvedValue({ deletedArticles: 0 });
});

const email = () => screen.getByRole("textbox", { name: "Contact email" }) as HTMLInputElement;
const saveSettings = () => screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;

// Settings as it opens, with an address typed into the form and not saved.
async function renderWithAnEdit() {
  render(
    <Settings
      pro={null}
      onDataChanged={() => {}}
      onPairingChanged={() => {}}
      onSharingChanged={() => {}}
      onPapersRemoved={() => {}}
      onTopicSaved={() => {}}
      onLibraryReset={() => {}}
    />
  );
  await screen.findByText("Sleep");
  fireEvent.change(email(), { target: { value: "reader@example.com" } });
  expect(saveSettings().disabled).toBe(false);
}

function expectTheEditKept() {
  expect(email().value).toBe("reader@example.com");
  expect(saveSettings().disabled).toBe(false);
  // The settings were read once, when the page opened, and not again.
  expect(api.getSettings).toHaveBeenCalledTimes(1);
}

describe("an edit not yet saved", () => {
  it("is still there after a topic is saved", async () => {
    api.getTopics.mockResolvedValueOnce([TOPIC]).mockResolvedValue([RENAMED]);
    await renderWithAnEdit();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Rest" } });
    // Not until the topic's stored scope has arrived.
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    // The list was fetched again, and shows the new name.
    await screen.findByText("Rest");
    expectTheEditKept();
  });

  it("is still there after a topic is removed", async () => {
    api.getTopics.mockResolvedValueOnce([TOPIC]).mockResolvedValue([]);
    await renderWithAnEdit();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await screen.findByText('Remove "Sleep"?');
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await screen.findByText("No topics yet.");
    expect(api.deleteTopic).toHaveBeenCalledWith(7);
    expectTheEditKept();
  });
});
