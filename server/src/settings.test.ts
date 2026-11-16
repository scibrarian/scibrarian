import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// Saving the settings, and the mail login a stored password belongs to — see
// settings.ts. Asked of the module directly, against a database of its own:
// what PUT /settings and the test email send is alerts.test.ts's, and so is
// what a mail server is sent.
//
// What matters most here is the password. It is write-only, it goes only to
// the server and username it was saved with, and it goes with the username.
// Each rule below is one that a save or a test email could break quietly: a
// password handed to another server is read back by whoever runs it.

let db: Db;
let settings: typeof import("./settings.js");

// What the schedule was each time a save reset it. The scheduler reads the
// settings itself, so this is what they were when it was asked to; and none
// is started in the test process.
const rescheduled = vi.hoisted(() => [] as { poll_enabled: string; poll_cron: string }[]);
vi.mock("./poller.js", async (importOriginal) => {
  const { getSettings } = await import("./db.js");
  return {
    ...(await importOriginal<typeof import("./poller.js")>()),
    rescheduleFromSettings: () => {
      const { poll_enabled, poll_cron } = getSettings();
      rescheduled.push({ poll_enabled, poll_cron });
    },
  };
});

// Alerts on, through a mail login with its password: what most tests change one
// thing about.
function configure(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    alert_email_enabled: "1",
    alert_email_to: "reader@example.org",
    smtp_host: "smtp.example.org",
    smtp_port: "",
    smtp_user: "sender@example.org",
    smtp_pass: "secret",
    smtp_from: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    db.setSetting(key as Parameters<Db["setSetting"]>[0], value);
  }
}

// What a refused save or test email throws: the status, and the message the
// dialog shows.
function refusal(work: () => unknown): unknown {
  try {
    work();
  } catch (err) {
    return err;
  }
  throw new Error("it wasn't refused");
}

beforeAll(async () => {
  db = await openTempDb("settings");
  settings = await import("./settings.js");
});

afterAll(closeTempDb);

beforeEach(() => {
  configure();
  rescheduled.length = 0;
});

describe("a save", () => {
  it("won't turn alerts on without somewhere to send them", () => {
    configure({ alert_email_enabled: "0", smtp_host: "" });
    expect(refusal(() => settings.saveSettings({ alert_email_enabled: true }))).toMatchObject({
      status: 400,
      message: "Add the mail server to send through.",
    });
    expect(db.getSettings().alert_email_enabled).toBe("0");
  });

  // nodemailer would refuse every send before reaching the server, while the
  // switch said On.
  it("won't turn alerts on with a username but no password", () => {
    configure({ alert_email_enabled: "0", smtp_pass: "" });
    expect(refusal(() => settings.saveSettings({ alert_email_enabled: true }))).toMatchObject({
      status: 400,
      message: "Add the password, or clear the username if the mail server needs no login.",
    });
    expect(db.getSettings().alert_email_enabled).toBe("0");
  });

  // Each is read by nodemailer as something other than the one address typed.
  it.each([
    "me@lab.org,boss",
    "me@lab.org;boss@x.org",
    '"boss@x.org"me@lab.org',
    "me(boss@x.org)@lab.org",
    "me@lab.org:boss",
    "me\\,x@lab.org",
  ])("refuses %s as the address to send to", (address) => {
    expect(refusal(() => settings.saveSettings({ alert_email_to: address }))).toMatchObject({
      status: 400,
      message: "The address to send alerts to isn't an email address.",
    });
    expect(db.getSettings().alert_email_to).toBe("reader@example.org");
  });

  it.each(["first.last+tag@sub.example.co.uk", "o'brien@example.ie", "me@[192.0.2.1]"])(
    "takes %s as the address to send to",
    (address) => {
      settings.saveSettings({ alert_email_to: address });
      expect(db.getSettings().alert_email_to).toBe(address);
    }
  );

  // With alerts off too: saved, the moved login would keep the old password,
  // and send it to the new server once alerts went on.
  it("won't save a new server without its password", () => {
    configure({ alert_email_enabled: "0" });
    expect(refusal(() => settings.saveSettings({ smtp_host: "mail.elsewhere.org" }))).toMatchObject({
      status: 400,
      message: "Enter the password for the new mail server.",
    });
    expect(db.getSettings().smtp_host).toBe("smtp.example.org");
  });

  it("replaces the password with one typed over it", () => {
    settings.saveSettings({ smtp_user: "sender@example.org", smtp_pass: "changed" });
    expect(db.getSettings().smtp_pass).toBe("changed");
  });

  it("removes the password along with the username", () => {
    const view = settings.saveSettings({ smtp_user: "", smtp_from: "alerts@example.org" });
    expect(view.has_smtp_pass).toBe(false);
    expect(db.getSettings().smtp_pass).toBe("");
  });

  it("doesn't keep a password typed without a username", () => {
    settings.saveSettings({ smtp_user: "", smtp_pass: "typed", smtp_from: "alerts@example.org" });
    expect(db.getSettings().smtp_pass).toBe("");
  });

  it("keeps the password through a save that leaves the login alone", () => {
    settings.saveSettings({ poll_cron: "0 7 * * *" });
    expect(db.getSettings().smtp_pass).toBe("secret");
  });

  it("keeps a password's leading and trailing spaces", () => {
    settings.saveSettings({ smtp_pass: " spaced out " });
    expect(db.getSettings().smtp_pass).toBe(" spaced out ");
  });

  it("refuses a port that isn't one", () => {
    expect(refusal(() => settings.saveSettings({ smtp_port: "smtp" }))).toMatchObject({ status: 400 });
  });

  // With alerts off, so each is refused by its own rule rather than by the
  // check that alerts can send, which turns most of them away too. Checked
  // whole before anything is written, so the good value beside it isn't.
  it.each([
    ["poll_cron", "every morning", "That isn't a valid cron expression."],
    ["smtp_port", "smtp", "The port must be a number from 1 to 65535."],
    ["alert_email_to", "reader", "The address to send alerts to isn't an email address."],
    ["smtp_from", "alerts", "The address to send from isn't an email address."],
  ])("refuses %s %j with alerts off, and writes nothing else it was sent", (key, value, message) => {
    configure({ alert_email_enabled: "0" });
    const before = db.getSettings();
    expect(refusal(() => settings.saveSettings({ ncbi_email: "me@lab.org", [key]: value }))).toMatchObject({
      status: 400,
      message,
    });
    expect(db.getSettings()).toEqual(before);
    expect(rescheduled).toEqual([]);
  });

  it("takes a blank schedule as the default one", () => {
    settings.saveSettings({ poll_cron: "0 7 * * *" });
    settings.saveSettings({ poll_cron: "  " });
    expect(db.getSettings().poll_cron).toBe("");
  });

  // This client never sends a secret nobody typed, but anything can call the
  // route: a blank secret is a field left alone, never a way to clear one.
  it("keeps the stored secrets through a save that sends them blank", () => {
    db.setSetting("ncbi_api_key", "key");
    const view = settings.saveSettings({ ncbi_api_key: "", smtp_pass: "   " });
    expect(db.getSettings()).toMatchObject({ ncbi_api_key: "key", smtp_pass: "secret" });
    expect(view).toMatchObject({ has_api_key: true, has_smtp_pass: true });
  });

  // The password is the one exception, above.
  it("trims what it saves", () => {
    settings.saveSettings({ ncbi_email: "  me@lab.org ", smtp_host: " smtp.example.org ", ncbi_api_key: " key " });
    expect(db.getSettings()).toMatchObject({
      ncbi_email: "me@lab.org",
      smtp_host: "smtp.example.org",
      ncbi_api_key: "key",
    });
  });

  it("saves each switch it is sent as it is set, and leaves the others", () => {
    db.setSetting("poll_enabled", "1");
    db.setSetting("library_open", "0");
    const view = settings.saveSettings({ library_open: true, alert_email_enabled: false });
    expect(db.getSettings()).toMatchObject({ poll_enabled: "1", library_open: "1", alert_email_enabled: "0" });
    expect(view).toMatchObject({ poll_enabled: true, library_open: true, alert_email_enabled: false });
    settings.saveSettings({ poll_enabled: false });
    expect(db.getSettings()).toMatchObject({ poll_enabled: "0", library_open: "1" });
  });

  it("puts the schedule it saved into effect", () => {
    settings.saveSettings({ poll_enabled: true, poll_cron: "0 7 * * *" });
    expect(rescheduled).toEqual([{ poll_enabled: "1", poll_cron: "0 7 * * *" }]);
  });
});

// What a test email is sent with: the dialog's values over the stored ones.
// Otherwise the stored password goes to whatever server the request names,
// which would let an admin read the write-only secret back.
describe("the mail login a test email takes", () => {
  it("won't take the stored password to another server", () => {
    expect(refusal(() => settings.mailSettingsFor({ smtp_host: "mail.elsewhere.org" }))).toMatchObject({
      status: 400,
      message: "Enter the password for the new mail server.",
    });
  });

  it("won't take the stored password with another username", () => {
    expect(refusal(() => settings.mailSettingsFor({ smtp_user: "someone-else@example.org" }))).toMatchObject({
      status: 400,
      message: "Enter the password for the new username.",
    });
  });

  it("takes another server with the password typed for it", () => {
    expect(settings.mailSettingsFor({ smtp_host: "mail.elsewhere.org", smtp_pass: "theirs" })).toMatchObject({
      smtp_host: "mail.elsewhere.org",
      smtp_user: "sender@example.org",
      smtp_pass: "theirs",
    });
  });

  // A login takes a username, so there is none to move. That no password is
  // then sent is the sending's: see alerts.test.ts.
  it("takes another server without a password when there's no username", () => {
    expect(
      settings.mailSettingsFor({
        smtp_host: "relay.elsewhere.org",
        smtp_user: "",
        smtp_from: "sender@example.org",
      })
    ).toMatchObject({ smtp_host: "relay.elsewhere.org", smtp_user: "" });
  });

  it("treats the server's name the same whatever its case", () => {
    expect(settings.mailSettingsFor({ smtp_host: "SMTP.Example.org" })).toMatchObject({ smtp_pass: "secret" });
  });
});
