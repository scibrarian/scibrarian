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
