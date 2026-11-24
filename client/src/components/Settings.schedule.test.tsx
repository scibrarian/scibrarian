// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Settings } from "./Settings";
import { createSources, SourcesContext, type SourcesApi } from "../lib/sources";
import type { ViewerCache } from "../lib/viewerCache";
import type { AppSettings } from "../types";

afterEach(cleanup);

// The Polling and NCBI forms: two panels, each saved by its own button.
//
// What's pinned is what each Save sends. The polling switch hides the schedule
// while it is off, and a hidden field must not ride along: an edit to it is not
// what the reader is saving, and an invalid one would fail the save on a field
// they cannot see. And each form sends only its own keys and takes back only
// those, so an edit waiting in the other is left alone.
//
// pro={null} so ProPanel never mounts, as in the other Settings tests.
const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

// Settings lists the topics from the sources store, which these tests leave
// empty.
const sources = createSources(api as unknown as SourcesApi);
const withSources = ({ children }: { children: ReactNode }) => (
  <SourcesContext.Provider value={sources}>{children}</SourcesContext.Provider>
);

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
  api.updateSettings.mockImplementation(async (patch: Partial<AppSettings>) => ({ ...SAVED, ...patch }));
});

async function renderSettings(settings: AppSettings = SAVED) {
  api.getSettings.mockResolvedValue(settings);
  render(
    <Settings
      pro={null}
      viewerCache={NO_CACHE}
      onAddTopic={() => {}}
      onEditTopic={() => {}}
      onPairingChanged={() => {}}
      onSharingChanged={() => {}}
      onPapersRemoved={() => {}}
    />,
    { wrapper: withSources }
  );
  await screen.findByRole("switch", { name: "Scheduled polling" });
}

const pollSwitch = () => screen.getByRole("switch", { name: "Scheduled polling" });
const schedule = () => screen.queryByRole("textbox", { name: /^Poll schedule/ }) as HTMLInputElement | null;
const email = () => screen.getByRole("textbox", { name: "Contact email" }) as HTMLInputElement;
const saveSchedule = () => screen.getByRole("button", { name: "Save schedule" }) as HTMLButtonElement;
const saveNcbi = () => screen.getByRole("button", { name: "Save NCBI settings" }) as HTMLButtonElement;

describe("the schedule", () => {
  it("is shown only while polling is on", async () => {
    await renderSettings();
    expect(schedule()).toBeNull();
    fireEvent.click(pollSwitch());
    expect(schedule()!.value).toBe("0 6 * * *");
    fireEvent.click(pollSwitch());
    expect(schedule()).toBeNull();
  });

  it("is saved with polling turned on", async () => {
    await renderSettings();
    fireEvent.click(pollSwitch());
    fireEvent.change(schedule()!, { target: { value: "0 7 * * *" } });
    fireEvent.click(saveSchedule());
    await waitFor(() => expect(saveSchedule().disabled).toBe(true));
    expect(api.updateSettings).toHaveBeenCalledWith({ poll_enabled: true, poll_cron: "0 7 * * *" });
  });

  it("isn't sent once hidden, and is back with the switch", async () => {
    await renderSettings({ ...SAVED, poll_enabled: true });
    fireEvent.change(schedule()!, { target: { value: "not a cron line" } });
    fireEvent.click(pollSwitch());
    fireEvent.click(saveSchedule());
    await waitFor(() => expect(saveSchedule().disabled).toBe(true));
    expect(api.updateSettings).toHaveBeenCalledWith({ poll_enabled: false });
    fireEvent.click(pollSwitch());
    expect(schedule()!.value).toBe("not a cron line");
  });

  // A hidden edit is nothing the reader can see to save.
  it("doesn't count as an edit while hidden", async () => {
    await renderSettings();
    fireEvent.click(pollSwitch());
    fireEvent.change(schedule()!, { target: { value: "0 7 * * *" } });
    fireEvent.click(pollSwitch());
    expect(saveSchedule().disabled).toBe(true);
  });
});

describe("each form's save", () => {
  it("sends only its own keys, and leaves an edit in the other form alone", async () => {
    await renderSettings({ ...SAVED, poll_enabled: true });
    fireEvent.change(schedule()!, { target: { value: "0 7 * * *" } });
    fireEvent.change(email(), { target: { value: "reader@example.org" } });

    fireEvent.click(saveNcbi());
    await waitFor(() => expect(saveNcbi().disabled).toBe(true));
    expect(api.updateSettings).toHaveBeenCalledWith({ ncbi_email: "reader@example.org" });
    expect(schedule()!.value).toBe("0 7 * * *");
    expect(saveSchedule().disabled).toBe(false);

    fireEvent.click(saveSchedule());
    await waitFor(() => expect(saveSchedule().disabled).toBe(true));
    expect(api.updateSettings).toHaveBeenLastCalledWith({ poll_enabled: true, poll_cron: "0 7 * * *" });
    expect(email().value).toBe("reader@example.org");
  });

  it("reports in its own panel", async () => {
    await renderSettings();
    fireEvent.change(email(), { target: { value: "reader@example.org" } });
    fireEvent.click(saveNcbi());
    const saved = await screen.findByText("Settings saved.");
    expect(saved.closest("section")!.querySelector("h2")!.textContent).toBe("NCBI access");
  });
});
