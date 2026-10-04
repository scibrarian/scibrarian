// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Settings } from "./Settings";
import type { ViewerCache } from "../lib/viewerCache";
import type { AppSettings } from "../types";

afterEach(cleanup);

// Settings' help: what is printed on the page, what sits behind an info icon,
// and that reading the help can't work the control it is about.
//
// The icons sit beside their fields' labels rather than inside them. Inside, a
// click that missed the icon by a pixel landed on the label, and for Open
// Library that is a switch which saves the moment it changes and opens every
// stored file to the network. jsdom has no layout, so "beside" is tested as
// what it comes to: the icon, and the line around it that a near miss lands
// on, are not the label.
//
// pro={null} so ProPanel never mounts: it fetches on its own and has nothing to
// do with any of this.
const api = vi.hoisted(() => ({
  getTopics: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

// A shared server, so the Sharing panel shows its addresses and Open Library.
const SHARED: AppSettings = {
  ncbi_email: "",
  poll_cron: "0 6 * * *",
  poll_enabled: false,
  library_open: false,
  has_api_key: false,
  share_urls: ["http://192.168.1.50:3001"],
  desktop: false,
};

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

async function renderSettings(settings: AppSettings = SHARED) {
  api.getTopics.mockResolvedValue([]);
  api.getSettings.mockResolvedValue(settings);
  api.updateSettings.mockReset();
  api.updateSettings.mockImplementation(async (patch: Partial<AppSettings>) => ({ ...settings, ...patch }));
  render(
    <Settings
      pro={null}
      viewerCache={NO_CACHE}
      onDataChanged={() => {}}
      onPairingChanged={() => {}}
      onSharingChanged={() => {}}
      onPapersRemoved={() => {}}
      onTopicSaved={() => {}}
      onLibraryReset={() => {}}
    />
  );
  await screen.findByRole("switch", { name: "Scheduled polling" });
}

const pollSwitch = () => screen.getByRole("switch", { name: "Scheduled polling" }) as HTMLInputElement;

describe("a click meant for the help", () => {
  it("leaves the polling switch alone, on the icon or on the line around it", async () => {
    await renderSettings();
    const icon = screen.getByRole("button", { name: /^When on, every topic is checked/ });
    fireEvent.click(icon);
    // The label line, which holds the words and the icon: a click in the gap
    // between them, or just past the icon, lands here.
    fireEvent.click(icon.parentElement!);
    expect(pollSwitch().checked).toBe(false);
    // The words are still the switch's label.
    fireEvent.click(screen.getByText("Scheduled polling"));
    expect(pollSwitch().checked).toBe(true);
  });

  it("doesn't submit the settings form", async () => {
    await renderSettings();
    fireEvent.click(screen.getByRole("button", { name: /^Optional but recommended/ }));
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("neither flips nor saves Open Library, from the sentence beside it", async () => {
    await renderSettings();
    const library = screen.getByRole("switch", { name: "Open Library" }) as HTMLInputElement;
    fireEvent.click(screen.getByText(/viewers can freely download stored files/));
    expect(library.checked).toBe(false);
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
});

describe("where the help is", () => {
  it("prints what a reader copies, rather than hiding it behind an icon", async () => {
    await renderSettings({ ...SHARED, share_urls: [] });
    expect(screen.getByText(/Format: min hour day month weekday/)).toBeTruthy();
    expect(screen.getByText("ADMIN_TOKEN")).toBeTruthy();
    expect(screen.getByText("server/.env")).toBeTruthy();
  });

  it("gives a field its icon's help as its description", async () => {
    await renderSettings();
    expect(
      screen.getByRole("textbox", { name: "Contact email", description: /^Optional but recommended/ })
    ).toBeTruthy();
    expect(pollSwitch()).toBe(
      screen.getByRole("switch", { name: "Scheduled polling", description: /^When on, every topic/ })
    );
  });

  it("leaves a heading's name its own, with the icon beside it", async () => {
    // In the heading, the icon's whole paragraph was part of the heading's
    // name, and a screen reader moving by heading read it as the title.
    await renderSettings();
    expect(screen.getByRole("heading", { name: "Topics" })).toBeTruthy();
  });
});
