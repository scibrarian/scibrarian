// Pure text-matching helpers for the PDF importer.

// An explicit "PMID: 12345678" label on the first pages is almost always the
// paper's own id (per-reference PMIDs live in the reference list, which the
// page cap excludes) and costs zero network requests to use.
const PMID_RE = /\bPMID\s*[:.]?\s*(\d{1,8})\b/i;

// DOI syntax per Crossref guidance; the suffix stops at whitespace, quotes and
// brackets.
//
// Parentheses are deliberately *not* terminators. Elsevier's PII-based DOIs —
// `10.1016/S0140-6736(14)60001-1`, i.e. most of the Lancet and a large share of
// clinical medicine — carry them inside the suffix, and stopping at the first
// `(` doesn't produce a partial DOI, it produces a *different* one: the prefix
// alone can resolve to an unrelated record rather than to nothing. A DOI
// written inside parentheses in prose is handled the other way round, by
// trimming a closer that nothing in the DOI opened (see trimDoi).
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>[\]{}]+/gi;

// Trim what the surrounding text contributed: sentence punctuation, and any
// trailing `)` with no matching `(` inside the DOI. Applied in a loop because
// the two interleave — `(10.1016/S0140-6736(14)60001-1).` ends with `).`, and
// stripping either one alone leaves the other stranded.
function trimDoi(raw: string): string {
  let doi = raw;
  for (;;) {
    const before = doi;
    doi = doi.replace(/[.,;:]+$/, "");
    if (doi.endsWith(")") && count(doi, ")") > count(doi, "(")) doi = doi.slice(0, -1);
    if (doi === before) return doi;
  }
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

export function findPmid(text: string): string | null {
  const m = text.match(PMID_RE);
  return m ? m[1] : null;
}

// Distinct DOI candidates in order of appearance (the title-page DOI is nearly
// always first). Lowercased: DOIs are case-insensitive, and this dedupes the
// same DOI printed in different cases.
export function findDois(text: string, max = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(DOI_RE)) {
    const doi = trimDoi(m[0]).toLowerCase();
    if (!seen.has(doi)) {
      seen.add(doi);
      out.push(doi);
      if (out.length >= max) break;
    }
  }
  return out;
}
