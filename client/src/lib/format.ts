// Small formatting helpers shared across components.

import type { LibraryStats, ProPushResult } from "../types";

/**
 * One copy-up sweep's counts, as a sentence.
 *
 * `remaining` is part of the completion test, not decoration. A first sweep
 * that transfers nothing — the master refused the very first upload, or the run
 * hit its per-run budget before sending anything — comes back
 * {sent: 0, skipped: 0, remaining: 12}, and calling that "everything is already
 * there" tells the operator the copy-up finished while twelve papers are
 * outstanding. That is the one thing this line must never say wrongly: it is
 * read as permission to stop worrying about whether the agency has the paper.
 */
export function describeSweep(r: ProPushResult): string {
  // A collision is not an outcome, and this function only reports outcomes. A
  // busy run returned before it looked at anything, so its zeros are defaults
  // rather than measurements — and {sent: 0, skipped: 0, remaining: 0} is
  // exactly what describeMoved reads as "everything is already there". The
  // caller shows `error` beside this, so a sync being under way is already on
  // screen; what would be new here is only the false half.
  if (r.busy) return "";
  return [describeMoved(r), describeUnreadable(r), describeHeldBack(r)].filter(Boolean).join(" ");
}

function describeMoved(r: ProPushResult): string {
  // Ahead of the all-zeros test, which this case would otherwise fall into and
  // be told the exact opposite of. An explicit 0 only: undefined is a run that
  // never counted a scope — or a Pro build too old to report one — and reading
  // that as "nothing is shared" would invent the same false confidence pointing
  // the other way.
  if (r.shared_collections === 0) {
    return "Nothing is shared with your organization yet, so nothing is being copied up.";
  }
  if (r.sent === 0 && r.skipped === 0 && r.remaining === 0) {
    return "Everything shared is already with your organization.";
  }
  // Nothing moved but work is outstanding. The sweep stopped before it started,
  // and only the error beside this can say why — but the count still has to be
  // honest on its own.
  if (r.sent === 0 && r.skipped === 0) {
    return `Nothing copied yet — ${r.remaining} still to go.`;
  }
  const parts = [
    r.sent > 0 ? `copied ${r.sent} up` : "",
    r.skipped > 0 ? `${r.skipped} already there` : "",
    r.remaining > 0 ? `${r.remaining} still to go` : "",
  ].filter(Boolean);
  const s = parts.join(", ");
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

/**
 * The files that could not be read, and so did not go.
 *
 * Ahead of the held-back line because it is the more urgent of the two: those
 * are staying put by design, these are a library that has lost files. And it
 * sits beside `remaining` rather than replacing it — they are still outstanding
 * and a later sweep will retry them, so "3 still to go" and "3 can't be read"
 * are both true and the pair is what makes the second actionable.
 *
 * Never merged into "already there". That sentence says the organisation holds
 * the paper; for these nobody does, and a writer reading it would stop looking
 * for a file that never arrived.
 */
function describeUnreadable(r: ProPushResult): string {
  if (!r.unreadable) return "";
  const n = r.unreadable;
  return n === 1
    ? "1 couldn't be sent — its stored PDF is missing."
    : `${n} couldn't be sent — their stored PDFs are missing.`;
}

/**
 * The files that are never going, and why.
 *
 * Papers matched by hand aren't shared: the app checked that the PMID exists,
 * not that the PDF is that paper, and an unverified claim that travels becomes
 * the whole organisation's problem rather than the writer's.
 *
 * Said out loud because it is otherwise undiscoverable — `match_method` appears
 * nowhere else in the UI, so a writer would see their files sitting in a shared
 * collection, never arriving, with nothing to explain it. `0` is a measured
 * answer worth staying quiet about; `undefined` is a run that never counted —
 * a Pro build that doesn't report this at all, or a sweep that returned before
 * it built a queue — and inventing a "none held back" for it would be a claim
 * nothing checked.
 */
function describeHeldBack(r: ProPushResult): string {
  if (!r.held_back) return "";
  const n = r.held_back;
  return `${n} ${n === 1 ? "paper isn't" : "papers aren't"} shared — matched by hand, so ${
    n === 1 ? "it" : "they"
  } can't be verified.`;
}

/**
 * One removal's counts, as a sentence.
 *
 * Three numbers, none of which can stand for the others. `asked` is what the
 * user ticked and is the only one that isn't a fact about the database — it is
 * what the request carried, not what became of it. `papers` is how many of
 * those the collection actually still held. `removed` is stored files, which
 * exceeds `papers` when the collection holds two copies of one article.
 *
 * They disagree in both directions and the message has to survive both. The
 * doubled-file case was already handled; the shortfall was not, so a tick set
 * of five that another tab had already emptied down to two still reported
 * "Removed 5 papers" — the one direction a user could have acted on, since it
 * says work happened that didn't.
 */
export function describeRemoval(asked: number, removed: number, papers: number): string {
  if (papers === 0) {
    return asked === 1
      ? "Nothing was removed — that paper had already left this collection."
      : "Nothing was removed — those papers had already left this collection.";
  }
  // Files only when they outnumber papers. Saying "(3 stored files)" beside
  // "3 papers" is noise about an implementation detail; saying it beside
  // "2 papers" is the answer to why three rows went.
  const files = removed > papers ? ` (${plural(removed, "stored file")})` : "";
  const gone = asked - papers;
  return (
    `Removed ${plural(papers, "paper")} from this collection${files}.` +
    (gone > 0 ? ` ${gone.toLocaleString()} had already left.` : "")
  );
}

/**
 * What a whole-library reset destroyed, as a sentence.
 *
 * Afterwards, and only afterwards. The confirmation beforehand says the same
 * fixed thing every time (see RESET_WARNING in Settings) — what it is asking
 * about is which sections empty, which is a fact about the app rather than
 * about this library. Once it has happened, the counts are the report: they are
 * the only thing that says the button did what it claimed, and how much.
 */
export function describeResetDone(s: LibraryStats): string {
  const contents = listContents(s);
  return contents === "" ? "This library was already empty." : `Deleted ${contents}.`;
}

/**
 * The contents themselves, as a list, or "" for an empty library.
 *
 * Zero counts are dropped rather than printed. "0 collections" spends a clause
 * on the absence of something, and with six kinds of thing the list is long
 * enough already — while a library that is empty in every one of them is better
 * served by a sentence saying so than by six zeroes.
 *
 * Stored files sit inside the collections entry instead of joining the list,
 * because they are not a sixth kind of thing: they are what is in the fifth,
 * and the only count here that names bytes on a disk. A collection can hold
 * none, so the clause is conditional on its own count and not on its parent's.
 */
function listContents(s: LibraryStats): string {
  const parts = [
    countOf(s.papers, "paper"),
    countOf(s.topics, "topic"),
    countOf(s.journals, "journal"),
    countOf(s.folders, "saved folder"),
    s.collections > 0
      ? countOf(s.collections, "collection") +
        (s.files > 0 ? ` holding ${countOf(s.files, "stored file")}` : "")
      : "",
  ].filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// "3 papers", "1 topic", "1,204 papers" — the pluralisation rule, spelled once.
//
// Separated thousands because every caller is reporting a quantity to a person
// rather than printing an id, and a library large enough to make the separator
// matter is exactly the one where the number is worth reading carefully. It is
// here rather than at the call sites so two messages about the same rows cannot
// disagree about how to write them — which is what "1,204 papers" from a reset
// beside "1204 papers" from a collection removal was.
export function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

// The same, and "" for none — the empty string is what drops the entry from the
// list above. Only listContents wants that; everywhere else a zero is a number
// worth printing.
function countOf(n: number, noun: string): string {
  return n === 0 ? "" : plural(n, noun);
}

// "A, B, C, et al." once the list exceeds `max` names.
export function formatAuthors(authors: string[], max: number): string {
  if (authors.length === 0) return "—";
  if (authors.length <= max) return authors.join(", ");
  return authors.slice(0, max).join(", ") + ", et al.";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Journal metrics are stored unrounded; show one decimal (the server rounds
// search results the same way).
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "in", "nor",
  "of", "on", "or", "the", "to", "via", "vs", "with",
]);

// NLM stores titles in sentence case ("Cell metabolism"); show them title-cased
// ("Cell Metabolism"). Words that already contain a capital (acronyms like HIV,
// JAMA, or "(London,") are left untouched; small words stay lowercase mid-title.
export function titleCaseJournal(s: string): string {
  return s
    .split(" ")
    .map((w, i) => {
      if (!w || /[A-Z]/.test(w)) return w;
      if (i > 0 && SMALL_WORDS.has(w.replace(/[^a-z]/g, ""))) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}
