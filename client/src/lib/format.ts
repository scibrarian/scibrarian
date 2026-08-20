// Small formatting helpers shared across components.

import type { ProPushResult } from "../types";

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
  const files = removed > papers ? ` (${removed} stored files)` : "";
  const gone = asked - papers;
  return (
    `Removed ${papers} paper${papers === 1 ? "" : "s"} from this collection${files}.` +
    (gone > 0 ? ` ${gone} had already left.` : "")
  );
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
