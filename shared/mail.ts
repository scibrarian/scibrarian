// The settings an email alert is sent with, apart from the password, which is
// write-only and travels on its own.
//
// Here because both halves list them. The dialog edits these and patches them
// into the Settings page after a save; the server reads them off a request over
// the saved ones, for a save and for a test email. Written out in each place, a
// field added to one list and missed in another would quietly go unsent with
// the test email, or unshown after a save.
export const MAIL_FIELDS = [
  "alert_email_to",
  "smtp_host",
  "smtp_port",
  "smtp_user",
  "smtp_from",
] as const;

export type MailField = (typeof MAIL_FIELDS)[number];

// Just those fields, out of all the settings.
export function mailFieldsOf(s: Record<MailField, string>): Record<MailField, string> {
  return Object.fromEntries(MAIL_FIELDS.map((key) => [key, s[key]])) as Record<MailField, string>;
}
