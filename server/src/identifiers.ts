// Pull identifiers out of arbitrary pasted text.
//
// Two callers read the same string for different purposes and must not drift:
// citation-ref.ts decides what one pasted reference *is*, and the search box
// widens a text query with exact identifier matches. A DOI recognised in one
// place and missed in the other is a paper reported as not held when it is —
// the one answer this area of the app must never give wrongly.
//
// DOI syntax is deliberately not re-specified here. It lives in pdf-match.ts
// because the PDF importer needs the same rules (Elsevier's parenthesised PII
// DOIs above all), and two regexes drifting apart would mean a paper matched on
// import and then missed when its own DOI was pasted back in.

import { findDois } from "./pdf-match.js";

// An explicit label or a PubMed URL. Both say "this number is a PMID", which a
// bare number on a line crowded with other numbers cannot.
export const PMID_LABEL_RE = /\bPMID\s*[:.]?\s*(\d{1,8})\b/i;
export const PUBMED_URL_RE = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,8})/i;
// A string that is nothing but a number.
export const BARE_PMID_RE = /^(\d{1,8})$/;

// Four digits in 1800–2099: what citation-ref.ts reads as a publication year.
const YEAR_LIKE_RE = /^(?:1[89]\d{2}|20\d{2})$/;

export interface Identifiers {
  pmid: string | null;
  /** Bare DOI, lowercased — DOIs are case-insensitive by specification. */
  doi: string | null;
}

/** A PMID the text *labelled* as one: "PMID: 123", or a pubmed.ncbi.nlm.nih.gov URL. */
export function labelledPmid(text: string): string | null {
  const m = PMID_LABEL_RE.exec(text) ?? PUBMED_URL_RE.exec(text);
  return m ? m[1] : null;
}

/** The whole string is a number and nothing else. */
export function barePmid(text: string): string | null {
  const m = BARE_PMID_RE.exec(text.trim());
  return m ? m[1] : null;
}

/** The first DOI in the text, lowercased. */
export function findDoi(text: string): string | null {
  const [doi] = findDois(text, 1);
  return doi ?? null;
}

/**
 * The identifiers a *search* should be widened by — both extracted
 * independently, with no precedence, because a pasted reference carrying a DOI
 * and a PMID should match on either.
 *
 * One deliberate difference from how citation-ref.ts reads the same text: a
 * bare four-digit year is not taken as a PMID. Pasting `2019` into /have is
 * unanswerable however it's read, so treating it as a PMID there costs nothing;
 * typing `2019` into a search box is an ordinary query, and quietly adding
 * whichever 1970s paper happens to hold PMID 2019 is noise in a result list.
 */
export function searchIdentifiers(q: string): Identifiers {
  const bare = barePmid(q);
  return {
    pmid: labelledPmid(q) ?? (bare && !YEAR_LIKE_RE.test(bare) ? bare : null),
    doi: findDoi(q),
  };
}
