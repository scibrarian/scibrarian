// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Settings } from "./Settings";
import type { ViewerCache } from "../lib/viewerCache";
import type { AppSettings } from "../types";

afterEach(cleanup);

// The email alerts row in the Polling form, and the dialog it opens.
//
// The dialog saves on its own, with only its own keys, while the form around
// the button is saved by Save settings. So what's pinned is the seam between
// them: a save in the dialog sends nothing of the form's, and leaves an edit
// waiting in the form exactly where it was — the bug the Open Library switch
// was written to avoid. And the row is a server build's: the desktop app sends
// no email, so it offers none.
//
// pro={null} so ProPanel never mounts, as in the other Settings tests.
const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  testEmail: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

const SAVED: AppSettings = {
  ncbi_email: "",
  poll_cron: "0 6 * * *",
  poll_enabled: true,
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
  api.getSettings.mockResolvedValue(SAVED);
  api.testEmail.mockResolvedValue({ ok: true });
});

function renderSettings() {
  render(
    <Settings
      pro={null}
      viewerCache={NO_CACHE}
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
  );
}

const configure = () => screen.findByRole("button", { name: "Configure email alerts…" });

async function openDialog() {
  fireEvent.click(await configure());
  return within(await screen.findByRole("dialog", { name: "Email alerts" }));
}

describe("where the row is", () => {
  it("is in a server build's Polling form", async () => {
    renderSettings();
    expect(await configure()).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
  });

  it("isn't in the desktop app", async () => {
    api.getSettings.mockResolvedValue({ ...SAVED, desktop: true });
    renderSettings();
    await screen.findByRole("button", { name: "Save settings" });
    expect(screen.queryByRole("button", { name: "Configure email alerts…" })).toBeNull();
  });

  it("is greyed out while scheduled polling is off", async () => {
    api.getSettings.mockResolvedValue({ ...SAVED, poll_enabled: false });
    renderSettings();
    expect(((await configure()) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the dialog", () => {
  it("saves only its own keys, and leaves an edit in the form alone", async () => {
    const saved: AppSettings = {
      ...SAVED,
      alert_email_enabled: true,
      alert_email_to: "reader@example.org",
      smtp_host: "smtp.example.org",
      has_smtp_pass: true,
    };
    api.updateSettings.mockResolvedValue(saved);
    renderSettings();
    const cron = (await screen.findByDisplayValue("0 6 * * *")) as HTMLInputElement;
    fireEvent.change(cron, { target: { value: "0 7 * * *" } });

    const dialog = await openDialog();
    fireEvent.click(dialog.getByRole("switch", { name: "Send email alerts" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Send to" }), {
      target: { value: "reader@example.org" },
    });
    fireEvent.change(dialog.getByRole("textbox", { name: "Server" }), {
      target: { value: "smtp.example.org" },
    });
    fireEvent.change(dialog.getByLabelText("Password"), { target: { value: "app-password" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).toHaveBeenCalledWith({
      alert_email_enabled: true,
      alert_email_to: "reader@example.org",
      smtp_host: "smtp.example.org",
      smtp_port: "",
      smtp_user: "",
      smtp_from: "",
      smtp_pass: "app-password",
    });
    // The form's edit is still there, and still unsaved.
    expect(cron.value).toBe("0 7 * * *");
    expect(
      (screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(screen.getByText("On · sent to reader@example.org")).toBeTruthy();
  });

  it("sends a test with what is typed, saved or not", async () => {
    renderSettings();
    const dialog = await openDialog();
    fireEvent.change(dialog.getByRole("textbox", { name: "Send to" }), {
      target: { value: "reader@example.org" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Send test email" }));

    expect(
      await dialog.findByText(/Test email sent to reader@example\.org\./)
    ).toBeTruthy();
    // A blank password is left out, so the server uses the stored one.
    expect(api.testEmail).toHaveBeenCalledWith({
      alert_email_to: "reader@example.org",
      smtp_host: "",
      smtp_port: "",
      smtp_user: "",
      smtp_from: "",
    });
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  // The server only sends the saved password to the server and username it was
  // saved with, so "leave blank to keep" stops being true once either changes.
  it("asks for the password again once the server changes", async () => {
    api.getSettings.mockResolvedValue({
      ...SAVED,
      smtp_host: "smtp.example.org",
      smtp_user: "sender@example.org",
      has_smtp_pass: true,
    });
    renderSettings();
    const dialog = await openDialog();
    const password = dialog.getByLabelText("Password") as HTMLInputElement;
    expect(password.placeholder).toBe("•••••• (leave blank to keep)");

    fireEvent.change(dialog.getByRole("textbox", { name: "Server" }), {
      target: { value: "mail.elsewhere.org" },
    });
    expect(password.placeholder).toBe("required");
    expect(dialog.queryByText("set")).toBeNull();
  });

  it("sends the password as typed, spaces and all", async () => {
    renderSettings();
    const dialog = await openDialog();
    fireEvent.change(dialog.getByLabelText("Password"), { target: { value: " spaced out " } });
    fireEvent.click(dialog.getByRole("button", { name: "Send test email" }));

    await waitFor(() => expect(api.testEmail).toHaveBeenCalledTimes(1));
    expect(api.testEmail.mock.calls[0][0].smtp_pass).toBe(" spaced out ");
  });

  it("shows what the server refused, and stays open", async () => {
    api.updateSettings.mockRejectedValue(new Error("Add the mail server to send through."));
    renderSettings();
    const dialog = await openDialog();
    fireEvent.click(dialog.getByRole("switch", { name: "Send email alerts" }));
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    expect(await dialog.findByText("Add the mail server to send through.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Email alerts" })).toBeTruthy();
  });
});
