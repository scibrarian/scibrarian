// Turn whatever the user typed into a valid FTS5 MATCH expression.
//
// This is a sanitizer, not a parser passthrough. FTS5's query language treats
// AND/OR/NOT/NEAR, quotes, parentheses, `*`, `^` and `:` as syntax, so handing
// it a raw search box is two bugs waiting: a stray quote or a bare `AND` throws
// a SQL error mid-keystroke, and `title:` would silently become a column filter
// against a column the user has never heard of. Every token is therefore
// re-quoted as a literal, and the only operator we emit is our own.
//
// Two behaviours are deliberate:
//
//   - **Prefix matching on every token.** The metadata search this widens is
//     `LIKE %foo%`, which matches mid-word as you type. FTS5 can't do infix on a
//     normal tokenizer, but a trailing `*` gets the important half: "resist"
//     finds "resistance" while the box is still being typed. Without it, a live
//     search box shows nothing until each word is finished.
//   - **Quoted phrases are honoured.** `"acquired resistance"` stays a phrase
//     rather than two AND-ed prefixes, because a writer hunting a specific claim
//     types the phrase they remember.

// The tokenizer the body-text index (pdf_text_fts) is built with. It lives here
// rather than beside the schema because it is half of this module's contract:
// the prefix `*` above only holds for an index that stores words as written.
//
// No stemming, deliberately. FTS5 runs a query through the same tokenizer as
// the text, prefixes included, and a half-typed word stems badly. Under porter,
// "hepatocy" became `hepatoci*` (a final y turns to i) and "resistan" ran past
// `resist`, the stem "resistance" was stored as, so body-text results vanished
// for a keystroke and came back on the next — about one prefix in seven across
// a sample of medical vocabulary. What stemming added on top of the prefix was
// a longer form finding a shorter one ("hepatocytes" finding "hepatocyte"), and
// losing that is the accepted cost. The metadata half of the same search box is
// a plain LIKE and never stemmed either.
//
// unicode61 so accented author names and Greek letters tokenize as words.
export const FTS_TOKENIZE = "unicode61";

// Unicode-aware, so accented author names and Greek letters in chemical names
// survive tokenization instead of splitting the word around them.
const TOKEN = /[\p{L}\p{N}]+/gu;

// FTS5 escapes a double quote inside a quoted string by doubling it. Tokens are
// stripped of quotes by TOKEN anyway; phrases keep this honest.
const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

function tokensOf(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((m) => m[0]);
}

// Returns null when the input carries nothing searchable (blank, or punctuation
// only). Callers treat null as "skip body matching entirely" rather than
// running a query that matches everything or nothing.
export function toFtsQuery(raw: string): string | null {
  const terms: string[] = [];
  let rest = raw;

  // Pull out balanced "quoted phrases" first; whatever is left is loose tokens.
  // An unbalanced trailing quote is not an error — the tail just falls through
  // to token handling, which is what someone mid-type would expect.
  rest = rest.replace(/"([^"]*)"/g, (_all, inner: string) => {
    const words = tokensOf(inner);
    // A single-word "phrase" is just a word, but keep it exact (no prefix `*`):
    // quoting it is the user asking for that word and not its longer relatives.
    if (words.length > 0) terms.push(quote(words.join(" ")));
    return " ";
  });

  for (const token of tokensOf(rest)) terms.push(`${quote(token)}*`);

  if (terms.length === 0) return null;
  // Explicit AND rather than relying on FTS5's implicit-AND default, which is a
  // compile-time option and not guaranteed across builds.
  return terms.join(" AND ");
}
