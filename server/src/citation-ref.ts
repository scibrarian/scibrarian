// Turn one line a writer pasted into something the library can be asked about.
//
// The input is whatever was on the clipboard: a PMID, a DOI, or a PubMed URL —
// on its own, or buried in a full Vancouver reference. An identifier is the
// only thing read out of it; a line carrying none is reported unreadable.
//
// Pure and tested, like fts-query.ts and pdf-match.ts: this decides what a
// pasted line *means*, and getting it wrong shows up as a paper the user holds
// being reported as not held — the one answer this feature must never give
// wrongly.
//
// An author and year used to be read off a citation string when no identifier
// was present, and matched against held papers. Removed 2026-08-05: a surname
// plus a year cannot uphold the invariant above. PubMed's stored date is the
// epub year often enough that a reference styled 2022 misses a held paper filed
// under 2021, and the surname match ran one lowercased word against a whole
// author string. Both failures land on "not held" for a paper the writer owns —
// the expensive answer, delivered silently. Reporting the line as unreadable
// instead sends them to the manual lookup they would otherwise have done anyway.

import { barePmid, findDoi, labelledPmid } from "./identifiers.js";

export type RefKind = "pmid" | "doi" | "unknown";

export interface ParsedRef {
  kind: RefKind;
  /** The line as pasted, trimmed — echoed back so a result row names its input. */
  input: string;
  pmid?: string;
  /** Bare DOI, lowercased (DOIs are case-insensitive). */
  doi?: string;
  /** Why nothing usable came out, for `kind: "unknown"` only. */
  reason?: string;
}

// PMID and DOI extraction live in identifiers.ts, shared with the search box so
// the two can't drift on what counts as an identifier.
//
// `barePmid` means a line that is nothing but a number: pasting a column of
// PMIDs out of a spreadsheet is a real way to ask this question, and a lone
// number can't be anything else here. It does mean a stray "2019" on its own
// line is read as a PMID — accepted deliberately, because short PMIDs are real
// (older papers have four- and five-digit ids) and refusing them would break
// the paste this rule exists for. Search makes the opposite call for the same
// input, and says why.

/**
 * Parse one pasted line. Never throws and never returns null: an unreadable
 * line comes back as `kind: "unknown"` with a reason, because a paste of thirty
 * references has to report the two it couldn't read rather than dropping them.
 */
export function parseRef(raw: string): ParsedRef {
  const input = raw.trim();
  if (!input) return { kind: "unknown", input, reason: "Blank line." };

  // A DOI is the most specific thing a line can carry, and a full reference
  // that has one usually ends with it — so it wins, including over a PMID on
  // the same line. Either would answer; taking the DOI first means one rule
  // rather than a tie-break that depends on where in the line each one sits.
  //
  // Extraction is shared with the PDF importer rather than re-specified here:
  // DOI syntax is fiddly (Elsevier's parenthesised PII DOIs above all), and two
  // regexes drifting apart would mean a paper matched on import and then
  // reported as not held when its own DOI was pasted back in.
  const doi = findDoi(input);
  if (doi) return { kind: "doi", input, doi };

  const pmid = labelledPmid(input) ?? barePmid(input);
  if (pmid) return { kind: "pmid", input, pmid };

  // Named for what the reader has to do about it. A reference that reached this
  // point is readable prose — it just carries nothing the library can be keyed
  // on, and the fix is to fetch its DOI or PMID.
  return { kind: "unknown", input, reason: "No PMID or DOI in this line." };
}

/**
 * Split a pasted block into candidate references, one per line. Blank lines are
 * dropped; everything else is kept, including lines that won't parse, so the
 * caller can report them rather than silently returning fewer answers than the
 * user pasted.
 */
export function splitRefs(block: string): string[] {
  return block
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
}
