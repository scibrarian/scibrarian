// Small formatting helpers shared across components.

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
