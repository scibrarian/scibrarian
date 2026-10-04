// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Settings } from "./Settings";
import { TopicDialog } from "./TopicDialog";
import type { ViewerCache } from "../lib/viewerCache";
import type { AppSettings, Topic, TopicDetail } from "../types";

afterEach(cleanup);

// What the Polling & NCBI form keeps while it holds edits not yet saved.
//
// The form is saved by its own button, and the Topics panel above it changes
// things on its own: a topic saved or removed changes its list. The panel used
// to answer that with the reload the page opens with, which fetches the
// settings as well and put the server's copy back over the form — an address
// typed and not yet saved was gone, and the button that would have saved it
// went grey with it. The list is the shell's now, and the panel reads nothing
// again when it changes.
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

// The desktop viewer cache, which the shell hands down. This is not that build,
// so it is the one the shell holds there: nothing read, and nothing to clear.
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

// The topics and the dialog that edits them are the shell's, handed down, so
// this stands in for the shell: it reads the list as App does, again whenever
// the panel or the dialog says it changed, and puts the dialog beside the
// panel. The real dialog rather than a stub, because what these pin is what
// the form keeps when a topic really is saved or removed.
function Shell() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [editing, setEditing] = useState<Topic | null>(null);
  const load = () => void api.getTopics().then(setTopics);
  useEffect(load, []);
  return (
    <>
      <Settings
        pro={null}
        viewerCache={NO_CACHE}
        topics={topics}
        topicsError={null}
        onAddTopic={() => {}}
        onEditTopic={setEditing}
        onDataChanged={load}
        onPairingChanged={() => {}}
        onSharingChanged={() => {}}
        onPapersRemoved={() => {}}
        onLibraryReset={() => {}}
      />
      <TopicDialog
        open={editing != null}
        topic={editing}
        topics={topics}
        onClose={() => setEditing(null)}
        onSaved={load}
      />
    </>
  );
}

// Settings as it opens, with an address typed into the form and not saved.
async function renderWithAnEdit() {
  render(<Shell />);
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
