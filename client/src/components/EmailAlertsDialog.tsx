import { FormEvent, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../api";
import { errorMessage } from "../lib/format";
import { mailFieldsOf } from "../../../shared/mail";
import { Banner } from "./Banner";
import { ModalShell } from "./Dialogs";
import type { AppSettings, MailSettingsDraft } from "../types";

// The email alerts and the mail server they go out through, opened from the
// Polling form. Its own dialog, and its own save, rather than six more fields
// in that form: a mail server is set up once and then left alone, and the form
// is what someone opens to change the schedule.
//
// Saves on its own, with only its own keys, so an edit waiting in the Polling
// form is neither sent with it nor overwritten by its answer — the parent
// patches in the fields this dialog owns, the way the Open Library switch does.
export function EmailAlertsDialog({
  open,
  settings,
  onSaved,
  onClose,
}: {
  open: boolean;
  // As last saved. The dialog starts from these each time it opens.
  settings: AppSettings;
  // Every save's reply, even one that lands after the dialog was closed: the
  // save was sent either way. The dialog closes itself.
  onSaved: (updated: AppSettings) => void;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(settings.alert_email_enabled);
  const [draft, setDraft] = useState<MailSettingsDraft>(() => mailFieldsOf(settings));
  // Write-only, like the NCBI key: blank keeps the stored one.
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(
    null
  );
  // Which opening a reply belongs to. A test can take fifteen seconds to time
  // out, and one that lands after the dialog was closed and opened again would
  // report on settings that are no longer the ones in front of the reader.
  const session = useRef(0);
  // A save still waiting for its reply. Closing the dialog doesn't take back a
  // save already sent, so one opened again waits for it, and then starts from
  // what it saved rather than offering the old values to save back over it.
  const saveInFlight = useRef(false);

  function startFrom(s: AppSettings) {
    setEnabled(s.alert_email_enabled);
    setDraft(mailFieldsOf(s));
    setPassword("");
  }

  // Each opening starts from what is saved, for PromptDialog's reason, and
  // before paint so the last session's draft can't flash.
  useLayoutEffect(() => {
    if (!open) return;
    session.current += 1;
    startFrom(settings);
    setSaving(saveInFlight.current);
    setTesting(false);
    setResult(null);
    // Only on opening: `settings` changing underneath an open dialog is the
    // parent's own save landing, and must not wipe the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function field(key: keyof MailSettingsDraft) {
    return {
      value: draft[key] ?? "",
      onChange: (e: { target: { value: string } }) => setDraft({ ...draft, [key]: e.target.value }),
    };
  }

  function withPassword(): MailSettingsDraft {
    // Sent as typed: a password can begin or end with a space.
    return password.trim() ? { ...draft, smtp_pass: password } : draft;
  }

  // The saved password is only sent to the server and username it was saved
  // with — the server refuses to send it anywhere else — so changing either
  // means typing the password for the new one. A username always needs one.
  const passwordKept =
    settings.has_smtp_pass &&
    draft.smtp_host.trim().toLowerCase() === settings.smtp_host.toLowerCase() &&
    draft.smtp_user.trim() === settings.smtp_user;
  const passwordNeeded = !passwordKept && draft.smtp_user.trim() !== "";

  async function sendTest() {
    const mine = session.current;
    setResult(null);
    setTesting(true);
    try {
      await api.testEmail(withPassword());
      if (session.current !== mine) return;
      setResult({
        kind: "success",
        message:
          `Test email sent to ${draft.alert_email_to.trim()}. ` +
          "If it isn't in the inbox, check the spam folder.",
      });
    } catch (err) {
      if (session.current !== mine) return;
      setResult({ kind: "error", message: errorMessage(err) });
    } finally {
      if (session.current === mine) setTesting(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    // Only while open, for ConfirmDialog's reason: the form stays up for its
    // exit, and a second click on Save would send it again.
    if (!open) return;
    const mine = session.current;
    saveInFlight.current = true;
    setResult(null);
    setSaving(true);
    try {
      const updated = await api.updateSettings({ ...withPassword(), alert_email_enabled: enabled });
      onSaved(updated);
      if (session.current === mine) {
        onClose();
      } else {
        startFrom(updated);
        setSaving(false);
      }
    } catch (err) {
      // Whichever opening is up, it was this save that failed.
      setResult({ kind: "error", message: errorMessage(err) });
      setSaving(false);
    } finally {
      saveInFlight.current = false;
    }
  }

  return (
    <ModalShell open={open} onClose={onClose} title="Email alerts">
      {/* noValidate: the server words what is wrong with an address, in the
          banner below, where a browser bubble would only say "invalid".

          The fields are a .stacked-form of their own, and the banner and the
          buttons sit outside it: that class styles every button inside it as
          its accent button, the banner's × included. */}
      <form className="alerts-form" onSubmit={save} noValidate>
        <div className="stacked-form">
          <p className="modal-message">
            One email after each scheduled check that finds new papers or runs into a problem,
            covering every topic. “Check for new papers” never sends one.
          </p>
          <div className="field">
            <label htmlFor="alerts-enabled">Send email alerts</label>
            <input
              id="alerts-enabled"
              type="checkbox"
              role="switch"
              className="switch"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
          </div>
          <label>
            Send to
            <input type="email" placeholder="you@example.org" {...field("alert_email_to")} />
          </label>

          <h3 className="modal-subheading">Mail server</h3>
          <p className="hint">
            The SMTP server your email provider gives for sending from other apps. Some, Gmail
            among them, want an app password here rather than your usual one.
          </p>
          <label>
            Server
            <input placeholder="smtp.example.org" {...field("smtp_host")} />
          </label>
          <label>
            Port
            <input type="number" min={1} max={65535} placeholder="587" {...field("smtp_port")} />
            <span className="hint">587 for STARTTLS, 465 for TLS.</span>
          </label>
          <label>
            Username
            <input autoComplete="off" placeholder="optional" {...field("smtp_user")} />
          </label>
          <div className="field">
            <span className="label-line">
              <label htmlFor="alerts-smtp-pass">Password</label>
              {passwordKept && (
                <span className="pill">
                  set <Check size={12} className="inline-icon" aria-hidden />
                </span>
              )}
            </span>
            <input
              id="alerts-smtp-pass"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                passwordKept
                  ? "•••••• (leave blank to keep)"
                  : passwordNeeded
                    ? "required"
                    : "optional"
              }
            />
          </div>
          <label>
            From address
            <input type="email" placeholder="defaults to the username" {...field("smtp_from")} />
          </label>
        </div>

        <Banner
          kind={result?.kind ?? "info"}
          message={result?.message ?? null}
          onDismiss={() => setResult(null)}
        />
        <div className="modal-actions">
          <button
            type="button"
            className="modal-actions-aside"
            onClick={sendTest}
            disabled={testing}
          >
            {testing ? "Sending…" : "Send test email"}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// The fields this dialog owns, out of a settings response — what the parent
// patches in after a save, leaving the rest of its form as the reader left it.
export function alertSettingsOf(s: AppSettings) {
  return {
    alert_email_enabled: s.alert_email_enabled,
    ...mailFieldsOf(s),
    has_smtp_pass: s.has_smtp_pass,
  };
}
