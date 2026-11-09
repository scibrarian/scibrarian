import nodemailer from "nodemailer";
import type { MailField } from "../../shared/mail.js";
import { IS_DESKTOP } from "./config.js";
import { alertArticles, getSettings, type AlertArticle } from "./db.js";
import type { TopicPoll } from "./poller.js";
import type { Settings } from "./types.js";
import { errMessage, httpError } from "./util.js";

// Email alerts: one message after a poll nobody was watching — the cron, or
// the catch-up a startup runs — saying what it found across every topic.
//
// One email for the whole run, never one a topic. Someone following ten topics
// would otherwise get ten, and a paper two of them match would arrive twice,
// which is the inbox of overlapping alerts this exists to replace. So each
// paper is listed once, under the first topic that found it, naming the others.
//
// Server builds only. The desktop app polls while its window is open and
// catches up the moment it launches, so whoever the email would reach is
// already looking at the feed it describes.

// How many papers one topic lists before the rest become a count. A broad
// all-of-PubMed topic can add hundreds in a day, and nobody reads that email.
const LISTED_PER_TOPIC = 20;

export const DEFAULT_SMTP_PORT = 587;

// The settings an email is sent with.
export type MailSettings = Pick<Settings, MailField | "smtp_pass">;

interface MailConfig {
  to: string;
  from: string;
  host: string;
  port: number;
  user: string;
  pass: string;
}

// Lenient on purpose: the mail server is the judge of an address, and this is
// only here to catch the wrong thing pasted into the field. No whitespace,
// which also keeps a line break — a header injection — out of the envelope.
// Nor any character nodemailer reads as structure in an address list: the
// comma or semicolon between addresses, quotes, a comment's parentheses, a
// group's colon, an escaping backslash. Let through, "me@lab.org,boss" was two
// recipients in a field that takes one, and "me\,x@lab.org" went to x@lab.org.
export function isEmailAddress(v: string): boolean {
  return /^[^\s@<>,;:"()\\]+@[^\s@<>,;:"()\\]+$/.test(v);
}

export const BAD_SMTP_PORT = "The port must be a number from 1 to 65535.";

// The port as a number, or null when it isn't one. Blank is the default.
export function smtpPort(v: string): number | null {
  if (!v) return DEFAULT_SMTP_PORT;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

// What these settings send with, or what is missing for them to send at all.
// The string is the reason, worded for the dialog the settings are entered in.
export function mailConfig(s: MailSettings): MailConfig | string {
  const to = s.alert_email_to.trim();
  const host = s.smtp_host.trim();
  if (!to) return "Add the address to send alerts to.";
  if (!isEmailAddress(to)) return "The address to send alerts to isn't an email address.";
  if (!host) return "Add the mail server to send through.";
  const port = smtpPort(s.smtp_port.trim());
  if (port === null) return BAD_SMTP_PORT;
  const user = s.smtp_user.trim();
  // A login takes both halves. nodemailer refuses a username without a
  // password before it reaches the server, with an error that reads as the
  // server turning the password down.
  if (user && !s.smtp_pass.trim()) {
    return "Add the password, or clear the username if the mail server needs no login.";
  }
  // The account's own address is the usual sender, and for most providers the
  // only one they will relay for. A username that isn't one — a relay's
  // "apikey" — needs a From of its own.
  const from = s.smtp_from.trim() || (isEmailAddress(user) ? user : "");
  if (!from) return "Add a From address — the username isn't an email address.";
  if (!isEmailAddress(from)) return "The address to send from isn't an email address.";
  return { to, from, host, port, user, pass: s.smtp_pass };
}

async function deliver(
  c: MailConfig,
  message: { subject: string; text: string; html?: string }
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    // 465 speaks TLS from the first byte. Any other port starts in the clear
    // and upgrades with STARTTLS — required rather than attempted once there is
    // a password to send, so a server that doesn't offer it is refused instead
    // of being handed the password unencrypted.
    secure: c.port === 465,
    requireTLS: c.port !== 465 && c.user !== "",
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    // nodemailer waits two minutes for a connection by default, which is a
    // long time to watch Send test email spin before hearing the port is wrong.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({
      from: { name: "Scibrarian", address: c.from },
      to: c.to,
      ...message,
    });
  } finally {
    transport.close();
  }
}

// What to tell the person at the dialog when the mail server said no. The real
// error goes to the log; this names the field most likely to be wrong. The
// server's own reply is passed on where it has one, since for a refused login
// it is often the only place the fix is written ("use an app password").
function describeSendError(err: unknown): string {
  const { code, response } = (err ?? {}) as { code?: unknown; response?: unknown };
  const said =
    typeof response === "string" && response.trim()
      ? ` The server said: ${response.replace(/\s+/g, " ").trim().slice(0, 300)}`
      : "";
  switch (code) {
    case "EAUTH":
      return `The mail server didn't accept that username and password.${said}`;
    case "ENOAUTH":
      return "The mail server wants a username and password.";
    case "EDNS":
      return "Couldn't find a mail server at that address.";
    case "ETIMEDOUT":
      return "The mail server didn't answer in time. Check the server and port.";
    case "ECONNECTION":
    case "ESOCKET":
      return "Couldn't connect to the mail server. Check the server and port.";
    case "ETLS":
      return "Couldn't set up an encrypted connection to the mail server. Check the port.";
    case "EENVELOPE":
      return `The mail server refused the From or To address.${said}`;
    default:
      return `The mail server didn't accept the message.${said}`;
  }
}

// Send a test message with the settings given, which are the dialog's and may
// not be saved yet. Throws an httpError for the dialog to show.
export async function sendTestEmail(s: MailSettings): Promise<void> {
  const config = mailConfig(s);
  if (typeof config === "string") throw httpError(400, config);
  try {
    await deliver(config, {
      subject: "Scibrarian test email",
      text:
        "This is a test from Scibrarian. If it reached you, the mail settings work.\n\n" +
        "Once email alerts are on, an email like this one arrives after each scheduled " +
        "check that finds new papers or runs into a problem.",
    });
  } catch (err) {
    console.warn(`[alerts] test email failed: ${errMessage(err)}`);
    throw httpError(502, describeSendError(err));
  }
}

// The email for one unattended poll, if it is due one. Never rejects: the
// caller is a timer with nowhere to put an error, and a mail server being down
// is no reason to report the poll itself as failed.
export async function sendPollAlert(polls: TopicPoll[]): Promise<void> {
  try {
    const s = getSettings();
    if (IS_DESKTOP || s.alert_email_enabled !== "1") return;
    const config = mailConfig(s);
    if (typeof config === "string") {
      console.warn(`[alerts] email alerts are on but can't be sent: ${config}`);
      return;
    }
    // Only the papers a topic will list. A full check or a back catalog is
    // summed up instead, and its thousands of rows needn't be read for that.
    const listable = polls.flatMap(newsOf);
    const articles = new Map(alertArticles([...new Set(listable)]).map((a) => [a.pmid, a]));
    const message = composeAlert(polls, articles);
    if (!message) return;
    await deliver(config, message);
    console.log(`[alerts] sent: ${message.subject}`);
  } catch (err) {
    console.warn(`[alerts] couldn't send the poll email: ${errMessage(err)}`);
  }
}

// ---------- the message ----------

interface ListedPaper {
  article: AlertArticle;
  // The run's other topics that found it too.
  alsoIn: string[];
}

type Section =
  | {
      kind: "listed";
      topicName: string;
      added: number;
      papers: ListedPaper[];
      // Found by this topic, and past what it lists.
      more: number;
      // Found by this topic, and listed under an earlier one.
      above: number;
      // Added from the back catalog of journals the topic hadn't searched
      // before, and counted after the list rather than in it.
      backCatalog: { added: number; journals: string[] } | null;
    }
  | { kind: "history"; topicName: string; added: number };

export interface AlertMessage {
  subject: string;
  text: string;
  html: string;
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

// What a poll added that is news: none of a full check of a topic's history,
// and none of a journal's back catalog.
function newsOf(p: TopicPoll): string[] {
  if (p.history) return [];
  const old = p.backCatalog?.pmids;
  return old ? p.addedPmids.filter((pmid) => !old.has(pmid)) : p.addedPmids;
}

// Newest first, the order the feed reads in. pub_date sorts as a string; the
// pmid breaks a tie, and is the newer record the higher it is.
function newestFirst(a: AlertArticle, b: AlertArticle): number {
  if (a.pub_date !== b.pub_date) return a.pub_date < b.pub_date ? 1 : -1;
  return Number(b.pmid) - Number(a.pmid);
}

function metaLine(a: AlertArticle): string {
  const authors =
    a.authors.length > 3 ? `${a.authors.slice(0, 3).join(", ")}, et al.` : a.authors.join(", ");
  return [a.journal_name, a.pub_date_display, authors].filter(Boolean).join(" · ");
}

function paperUrl(a: AlertArticle): string {
  return a.url || `https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`;
}

function historyLine(s: Extract<Section, { kind: "history" }>): string {
  return (
    `${plural(s.added, "paper")} from a full check of its history — its first, or the ` +
    "first since its search changed — so they aren't listed here."
  );
}

// A topic whose only additions were a back catalog has no news to count.
function listedHeading(s: Extract<Section, { kind: "listed" }>): string {
  return s.added > 0 ? `${s.topicName} — ${plural(s.added, "new paper")}` : s.topicName;
}

// Up to three journals by name. A topic can be given a dozen in one edit, and
// a sentence naming all of them is not one anybody reads.
function journalList(names: string[]): string {
  const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} others`] : names;
  return new Intl.ListFormat("en-US", { type: "conjunction" }).format(shown);
}

function backCatalogLine(
  s: Extract<Section, { kind: "listed" }>,
  b: { added: number; journals: string[] }
): string {
  const from =
    `from the back catalog${b.journals.length === 1 ? "" : "s"} of ` +
    `${journalList(b.journals)}.`;
  return s.added > 0
    ? `Plus ${b.added.toLocaleString("en-US")} ${from}`
    : `${plural(b.added, "paper")} ${from}`;
}

function trailingLines(s: Extract<Section, { kind: "listed" }>): string[] {
  const lines: string[] = [];
  if (s.more > 0) lines.push(`…and ${s.more.toLocaleString("en-US")} more in Scibrarian.`);
  if (s.above > 0) {
    lines.push(
      s.above === s.added
        ? `${s.added === 1 ? "It is" : `All ${s.added} are`} listed above, under another topic.`
        : `Plus ${s.above.toLocaleString("en-US")} listed above, under another topic.`
    );
  }
  if (s.backCatalog) lines.push(backCatalogLine(s, s.backCatalog));
  return lines;
}

const FOOTER =
  "Sent by Scibrarian after a scheduled check. To stop these emails, turn email alerts off in " +
  "Settings.";

// What one run's email says, or null when it has nothing to say: no topic
// added anything, failed, or hit PubMed's cap. `articles` holds the papers the
// listed topics found; one it lacks (removed since) is left out of the list.
export function composeAlert(
  polls: TopicPoll[],
  articles: Map<string, AlertArticle>
): AlertMessage | null {
  // Every topic each paper went into on this run, in topic order.
  const topicsOf = new Map<string, string[]>();
  for (const p of polls) {
    for (const pmid of p.addedPmids) {
      const names = topicsOf.get(pmid);
      if (names) names.push(p.result.topicName);
      else topicsOf.set(pmid, [p.result.topicName]);
    }
  }
  const failed = polls.filter((p) => p.result.error);
  const capped = polls.filter((p) => p.result.truncated);
  if (topicsOf.size === 0 && failed.length === 0 && capped.length === 0) return null;

  const listed = new Set<string>();
  const sections: Section[] = [];
  for (const p of polls) {
    const topicName = p.result.topicName;
    if (p.addedPmids.length === 0) continue;
    if (p.history) {
      sections.push({ kind: "history", topicName, added: p.addedPmids.length });
      continue;
    }
    const news = newsOf(p);
    const added = news.length;
    const old = p.addedPmids.length - added;
    const unlisted = news.filter((pmid) => !listed.has(pmid));
    const shown = unlisted
      .map((pmid) => articles.get(pmid))
      .filter((a): a is AlertArticle => a !== undefined)
      .sort(newestFirst)
      .slice(0, LISTED_PER_TOPIC);
    for (const a of shown) listed.add(a.pmid);
    sections.push({
      kind: "listed",
      topicName,
      added,
      papers: shown.map((article) => ({
        article,
        alsoIn: (topicsOf.get(article.pmid) ?? []).filter((n) => n !== topicName),
      })),
      more: unlisted.length - shown.length,
      above: added - unlisted.length,
      backCatalog:
        p.backCatalog && old > 0 ? { added: old, journals: p.backCatalog.journals } : null,
    });
  }

  const problems = [
    ...failed.map((p) => `${p.result.topicName} couldn't be checked: ${p.result.error}`),
    ...capped.map(
      (p) =>
        `${p.result.topicName} matches more papers than PubMed will return — ` +
        `${p.result.truncated!.toLocaleString("en-US")} older ones were left out. ` +
        "Narrow where it searches for full coverage."
    ),
  ];

  // The count is of the papers that are news. A topic that read its history
  // is named instead of counted: its first check can add thousands, and a
  // subject reading "4,012 new papers" for four is the one figure in the email
  // that is wrong. A back catalog is the same, a journal at a time, and it is
  // the journals that are counted: their names are too long for a subject.
  const fresh = new Set(polls.flatMap(newsOf));
  const inFull = sections.filter((s) => s.kind === "history").length;
  const backCatalogs = new Set(
    sections.flatMap((s) => (s.kind === "listed" && s.backCatalog ? s.backCatalog.journals : []))
  );
  const subjectParts: string[] = [];
  if (fresh.size > 0) subjectParts.push(plural(fresh.size, "new paper"));
  if (inFull > 0) subjectParts.push(`${plural(inFull, "topic")} checked in full`);
  if (backCatalogs.size > 0) {
    subjectParts.push(
      backCatalogs.size === 1
        ? "back catalog of 1 journal"
        : `back catalogs of ${plural(backCatalogs.size, "journal")}`
    );
  }
  if (failed.length > 0) subjectParts.push(`${plural(failed.length, "topic")} couldn't be checked`);
  if (subjectParts.length === 0) {
    subjectParts.push(`${plural(capped.length, "topic")} hit PubMed's limit`);
  }

  return {
    subject: `Scibrarian: ${subjectParts.join(", ")}`,
    text: renderText(sections, problems),
    html: renderHtml(sections, problems),
  };
}

function renderText(sections: Section[], problems: string[]): string {
  const blocks: string[] = [];
  for (const s of sections) {
    if (s.kind === "history") {
      blocks.push(`${s.topicName}\n${historyLine(s)}`);
      continue;
    }
    // A heading with nothing listed under it reads on into its line, as a
    // full check's does.
    const lines = s.added > 0 ? [listedHeading(s), ""] : [listedHeading(s)];
    for (const { article, alsoIn } of s.papers) {
      lines.push(`- ${article.title}`);
      const meta = metaLine(article);
      if (meta) lines.push(`  ${meta}`);
      lines.push(`  ${paperUrl(article)}`);
      if (alsoIn.length > 0) lines.push(`  Also in: ${alsoIn.join(", ")}`);
      lines.push("");
    }
    lines.push(...trailingLines(s));
    blocks.push(lines.join("\n").trimEnd());
  }
  if (problems.length > 0) {
    blocks.push(["Needs attention", ...problems.map((p) => `- ${p}`)].join("\n"));
  }
  blocks.push(FOOTER);
  return blocks.join("\n\n") + "\n";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline styles only: most mail clients drop a <style> block, and every one of
// them drops the app's stylesheet.
const H2 = 'style="font-size:16px;margin:24px 0 8px"';
const MUTED = 'style="color:#666;font-size:13px"';
const P_MUTED = 'style="color:#666;font-size:13px;margin:0 0 8px"';

function renderHtml(sections: Section[], problems: string[]): string {
  const out: string[] = [];
  for (const s of sections) {
    if (s.kind === "history") {
      out.push(`<h2 ${H2}>${escapeHtml(s.topicName)}</h2>`);
      out.push(`<p ${P_MUTED}>${escapeHtml(historyLine(s))}</p>`);
      continue;
    }
    out.push(`<h2 ${H2}>${escapeHtml(listedHeading(s))}</h2>`);
    if (s.papers.length > 0) {
      out.push('<ul style="padding-left:18px;margin:0 0 8px">');
      for (const { article, alsoIn } of s.papers) {
        const parts = [
          `<a href="${escapeHtml(paperUrl(article))}">${escapeHtml(article.title)}</a>`,
        ];
        const meta = metaLine(article);
        if (meta) parts.push(`<span ${MUTED}>${escapeHtml(meta)}</span>`);
        if (alsoIn.length > 0) {
          parts.push(`<span ${MUTED}>Also in: ${escapeHtml(alsoIn.join(", "))}</span>`);
        }
        out.push(`<li style="margin:0 0 10px">${parts.join("<br>")}</li>`);
      }
      out.push("</ul>");
    }
    for (const line of trailingLines(s)) out.push(`<p ${P_MUTED}>${escapeHtml(line)}</p>`);
  }
  if (problems.length > 0) {
    out.push(`<h2 ${H2}>Needs attention</h2>`);
    out.push('<ul style="padding-left:18px;margin:0 0 8px">');
    for (const p of problems) out.push(`<li style="margin:0 0 6px">${escapeHtml(p)}</li>`);
    out.push("</ul>");
  }
  out.push(`<p style="color:#666;font-size:12px;margin:32px 0 0">${escapeHtml(FOOTER)}</p>`);
  return (
    '<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,' +
    'sans-serif;font-size:14px;line-height:1.45;color:#222">' +
    out.join("\n") +
    "</body></html>"
  );
}
