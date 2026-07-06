// Pure text-matching helpers for the PDF importer.

// An explicit "PMID: 12345678" label on the first pages is almost always the
// paper's own id (per-reference PMIDs live in the reference list, which the
// page cap excludes) and costs zero network requests to use.
const PMID_RE = /\bPMID\s*[:.]?\s*(\d{1,8})\b/i;

// DOI syntax per Crossref guidance; suffix stops at whitespace/quotes/brackets,
// then trailing sentence punctuation is trimmed off.
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>()[\]{}]+/gi;

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
    const doi = m[0].replace(/[.,;:]+$/, "").toLowerCase();
    if (!seen.has(doi)) {
      seen.add(doi);
      out.push(doi);
      if (out.length >= max) break;
    }
  }
  return out;
}
