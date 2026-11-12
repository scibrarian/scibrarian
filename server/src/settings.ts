import os from "node:os";
import { BAD_SMTP_PORT, isEmailAddress, mailConfig, smtpPort, type MailSettings } from "./alerts.js";
import { boundPort, HOST, HOST_IS_LOOPBACK, IS_DESKTOP } from "./config.js";
import { getSettings, setSetting } from "./db.js";
import { isValidCron, rescheduleFromSettings } from "./poller.js";
import type { AppSettings, Settings } from "./types.js";
import { httpError } from "./util.js";
import { MAIL_FIELDS, mailFieldsOf } from "../../shared/mail.js";

// Saving the settings and showing them, and the mail login a stored password
// belongs to (see GLOSSARY.md).
//
// A save is a patch: only the keys a request carries change. It is checked
// whole before anything is written, so a refused value can't leave it half
// applied, and a refusal is thrown as an httpError(400) carrying the reason the
// dialog shows. The secrets — the NCBI API key and the mail password — are
// write-only: a save can set one, and nothing here hands one back.

// ---------- what the client is shown ----------

// Every setting but the secrets, of which it is told only whether one is set,
// and two facts that aren't settings. Written out rather than derived from the
// rules below, so the compiler holds it to AppSettings.
export function settingsView(): AppSettings {
  const s = getSettings();
  return {
    ncbi_email: s.ncbi_email,
    poll_cron: s.poll_cron,
    poll_enabled: s.poll_enabled === "1",
    library_open: s.library_open === "1",
    has_api_key: Boolean(s.ncbi_api_key),
    alert_email_enabled: s.alert_email_enabled === "1",
    alert_email_to: s.alert_email_to,
    smtp_host: s.smtp_host,
    smtp_port: s.smtp_port,
    smtp_user: s.smtp_user,
    smtp_from: s.smtp_from,
    has_smtp_pass: Boolean(s.smtp_pass),
    share_urls: shareUrls(), // derived from the bind address, not a setting
    // Also not a setting: how the server was launched. share_urls is empty for
    // both a loopback server and a desktop app, but the fix differs — one can be
    // rebound via server/.env, the other has no .env to edit — so the UI needs
    // to tell the two apart.
    desktop: IS_DESKTOP,
  };
}

// Where other machines can reach this server, for the Settings sharing panel.
// A loopback bind isn't shareable; a wildcard bind maps to every external IPv4
// address this machine has (LAN, Tailscale, …).
//
// boundPort(), not PORT: these are addresses someone is about to type into
// another machine's browser, so they have to name the port the socket is
// actually on. With PORT=0 the configured value is 0 and the OS picked the real
// one at bind time.
function shareUrls(): string[] {
  if (HOST_IS_LOOPBACK) return [];
  const port = boundPort();
  if (HOST !== "0.0.0.0" && HOST !== "::") return [`http://${HOST}:${port}`];
  const urls: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) urls.push(`http://${info.address}:${port}`);
    }
  }
  return urls;
}

// ---------- a save ----------

// Apply a patch of settings, and answer with what the client is now shown.
export function saveSettings(patch: unknown): AppSettings {
  const body = asBody(patch);
  checkValues(body);
  // Whether alerts are on or not: a login moved without its password would
  // otherwise be saved with the old one, which would go to the new server as
  // soon as alerts were on.
  const mail = mailSettingsAfter(body);
  checkAlertsCanSend(body, mail);
  write(body);
  // A password is only ever sent with a username, so one left without could
  // never be used again. Clearing the username is how a login is taken away.
  if (!mail.smtp_user) setSetting("smtp_pass", "");
  rescheduleFromSettings();
  return settingsView();
}

// How a save persists each setting. `satisfies Record<keyof Settings, …>` makes
// the table exhaustive — adding a setting to SETTING_DEFAULTS without deciding
// its rule is a compile error, so a new toggle can never round-trip 200 without
// persisting.
type SettingRule =
  | { kind: "string"; validate?: (value: string) => string | null } // returns an error message
  | { kind: "boolean" }
  // write-only: the client is told only whether one is set (settingsView).
  // `verbatim` stores it untrimmed.
  | { kind: "secret"; verbatim?: true };

const SETTING_RULES = {
  ncbi_email: { kind: "string" },
  // A blank cron means "use the default"; anything else must be valid, or the
  // scheduler would silently fall back to the default while the UI reported a
  // successful save.
  poll_cron: {
    kind: "string",
    validate: (v) => (v && !isValidCron(v) ? "That isn't a valid cron expression." : null),
  },
  poll_enabled: { kind: "boolean" },
  library_open: { kind: "boolean" },
  ncbi_api_key: { kind: "secret" },
  alert_email_enabled: { kind: "boolean" },
  alert_email_to: { kind: "string", validate: validEmailOrBlank("send alerts to") },
  smtp_host: { kind: "string" },
  smtp_port: {
    kind: "string",
    validate: (v) => (smtpPort(v) === null ? BAD_SMTP_PORT : null),
  },
  smtp_user: { kind: "string" },
  // Stored as typed, where an API key is trimmed: a password can begin or end
  // with a space.
  smtp_pass: { kind: "secret", verbatim: true },
  smtp_from: { kind: "string", validate: validEmailOrBlank("send from") },
} satisfies Record<keyof Settings, SettingRule>;

const SETTING_KEYS = Object.keys(SETTING_RULES) as (keyof Settings)[];

function validEmailOrBlank(purpose: string) {
  return (v: string) =>
    v && !isEmailAddress(v) ? `The address to ${purpose} isn't an email address.` : null;
}

function asBody(patch: unknown): Record<string, unknown> {
  return (patch ?? {}) as Record<string, unknown>;
}

// Every value the patch carries, against its rule, before anything is written.
function checkValues(body: Record<string, unknown>): void {
  for (const key of SETTING_KEYS) {
    const rule: SettingRule = SETTING_RULES[key];
    const value = body[key];
    if (rule.kind === "string" && rule.validate && typeof value === "string") {
      const err = rule.validate(value.trim());
      if (err) throw httpError(400, err);
    }
  }
}

// Alerts that are on have to be able to send, judged on what the save would
// leave rather than on the fields it carries. Turned on without a mail server,
// they would fail in the log after every scheduled check while the switch said
// all was well.
function checkAlertsCanSend(body: Record<string, unknown>, mail: MailSettings): void {
  const enabledAfter =
    typeof body.alert_email_enabled === "boolean"
      ? body.alert_email_enabled
      : getSettings().alert_email_enabled === "1";
  if (!enabledAfter) return;
  const config = mailConfig(mail);
  if (typeof config === "string") throw httpError(400, config);
}

function write(body: Record<string, unknown>): void {
  for (const key of SETTING_KEYS) {
    const rule: SettingRule = SETTING_RULES[key];
    const value = body[key];
    if (rule.kind === "string" && typeof value === "string") {
      setSetting(key, value.trim());
    } else if (rule.kind === "boolean" && typeof value === "boolean") {
      setSetting(key, value ? "1" : "0");
    } else if (rule.kind === "secret" && typeof value === "string" && value.trim()) {
      // Secrets are write-only: only overwrite on an explicit non-empty value.
      setSetting(key, rule.verbatim ? value : value.trim());
    }
  }
}

// ---------- the mail login ----------

// What a test email is sent with: the dialog's values, which may not have been
// saved, over the stored ones — with the stored password only for its own login.
export function mailSettingsFor(patch: unknown): MailSettings {
  return mailSettingsAfter(asBody(patch));
}

// The mail settings a request would leave saved: its own values over the
// stored ones. A blank password keeps the stored one, as it does on a save —
// but only for the server and username it was saved with. Anywhere else it
// would hand one mail server the password for another, and let an admin read
// the write-only secret back by pointing the test email at a server of their
// own. So a request that moves the login has to bring its password with it, or
// it is refused saying so.
function mailSettingsAfter(body: Record<string, unknown>): MailSettings {
  const s = getSettings();
  const after = mailFieldsOf(s);
  for (const key of MAIL_FIELDS) {
    const v = body[key];
    if (typeof v === "string") after[key] = v.trim();
  }
  const typed = body.smtp_pass;
  if (typeof typed === "string" && typed.trim()) return { ...after, smtp_pass: typed };
  // Without a username no password is sent, so there is nothing to refuse.
  if (s.smtp_pass && after.smtp_user) {
    if (after.smtp_host.toLowerCase() !== s.smtp_host.toLowerCase()) {
      throw httpError(400, "Enter the password for the new mail server.");
    }
    if (after.smtp_user !== s.smtp_user) throw httpError(400, "Enter the password for the new username.");
  }
  return { ...after, smtp_pass: s.smtp_pass };
}
