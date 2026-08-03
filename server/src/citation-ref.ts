// Turn one line a writer pasted into something the library can be asked about.
//
// The input is whatever was on the clipboard: a PMID, a DOI, a PubMed URL, a
// full Vancouver reference, or the client-formatted locator string writers
// actually work from — `[Smith 2019/p1699/col2/par1/lines 6-12]`. Only the
// first two are identifiers; the rest have to be reduced to something a SQL
// query can hold, which is the author's surname and the year.
//
// Pure and tested, like fts-query.ts and pdf-match.ts: this decides what a
// pasted line *means*, and getting it wrong shows up as a paper the user holds
// being reported as not held — the one answer this feature must never give
// wrongly.

// The locator tail (`/p1699/col2/par1/lines 6-12`) is deliberately dropped
// here. Resolving it to a place inside the PDF is Phase 4; parsing it now would
// invent a format before there are real examples to design against.

import { barePmid, findDoi, labelledPmid } from "./identifiers.js";

export type RefKind = "pmid" | "doi" | "citation" | "unknown";

export interface ParsedRef {
  kind: RefKind;
  /** The line as pasted, trimmed — echoed back so a result row names its input. */
  input: string;
  pmid?: string;
  /** Bare DOI, lowercased (DOIs are case-insensitive). */
  doi?: string;
  /** Surname as written, for display: "van der Berg". */
  author?: string;
  /**
   * The single word an author search matches on, lowercased. For a surname with
   * particles this is the last word ("berg"), because PubMed stores the whole
   * surname in one string ("Van Der Berg J") and a substring match on the
   * distinctive word finds it however the particles were capitalized or spaced.
   */
  authorKey?: string;
  year?: number;
  /** Why nothing usable came out, for `kind: "unknown"` only. */
  reason?: string;
}

// PMID and DOI extraction live in identifiers.ts, shared with the search box so
// the two can't drift on what counts as an identifier.
//
// `barePmid` means a line that is nothing but a number: pasting a column of
// PMIDs out of a spreadsheet is a real way to ask this question, and a lone
// number can't be anything else here. It does mean a stray "2019" on its own
// line is read as a PMID rather than a year — accepted deliberately, because a
// year with no author or title is unanswerable either way, while short PMIDs
// are real (older papers have four- and five-digit ids) and refusing them would
// break the paste this rule exists for. Search makes the opposite call for the
// same input, and says why.

// A four-digit year standing on its own. The negative lookbehind is what keeps
// `p1699` — the page number in a locator string — from being read as a year;
// without it the most common input this feature exists for parses to the wrong
// one of its two numbers. The range starts at 1800 because MEDLINE's oldest
// records are 19th century and nothing citable predates that.
const YEAR_RE = /(?<![A-Za-z0-9])(1[89]\d{2}|20\d{2})(?![0-9])/;

// Words that lead a reference without being the author. "et al" is the common
// one; the rest turn up when a citation is quoted inside a sentence.
const NOT_A_SURNAME = new Set([
  "et", "al", "the", "and", "in", "see", "ref", "refs", "cf", "per", "from", "as",
]);

// Surname particles. They lead the surname but aren't the part that identifies
// it, so `authorKey` skips past them (see ParsedRef.authorKey).
const PARTICLES = new Set([
  "van", "von", "de", "del", "della", "der", "den", "di", "da", "dos", "du",
  "la", "le", "el", "bin", "ibn", "st",
]);

// A word that could be part of a surname: letters, plus the hyphen and
// apostrophe real names carry. Unicode-aware so "Müller" and "Öztürk" survive.
const WORD_RE = /[\p{L}][\p{L}'’-]*/gu;

/**
 * Parse one pasted line. Never throws and never returns null: an unreadable
 * line comes back as `kind: "unknown"` with a reason, because a paste of thirty
 * references has to report the two it couldn't read rather than dropping them.
 */
export function parseRef(raw: string): ParsedRef {
  const input = raw.trim();
  if (!input) return { kind: "unknown", input, reason: "Blank line." };

  // A DOI is the most specific thing a line can carry, and a full reference
  // that has one usually ends with it — so it wins over everything else,
  // including an author and year sitting in front of it.
  //
  // Extraction is shared with the PDF importer rather than re-specified here:
  // DOI syntax is fiddly (Elsevier's parenthesised PII DOIs above all), and two
  // regexes drifting apart would mean a paper matched on import and then
  // reported as not held when its own DOI was pasted back in.
  const doi = findDoi(input);
  if (doi) return { kind: "doi", input, doi };

  const pmid = labelledPmid(input) ?? barePmid(input);
  if (pmid) return { kind: "pmid", input, pmid };

  return parseCitation(input);
}

// Author + year out of a citation string. Both are required: a year alone
// selects a whole year of the library, and a surname alone selects an author's
// whole career — neither answers "do I have *this* paper", so a half-parse is
// reported as unreadable rather than turned into a search that looks like it
// worked.
function parseCitation(input: string): ParsedRef {
  const yearMatch = YEAR_RE.exec(input);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  // Only the text before the year can hold the author. In every format seen —
  // `[Smith 2019/...]`, `(Smith et al., 2019)`, `Smith J, Jones A. Title.
  // Journal. 2019;380(4):1699.` — the name leads and the year follows, so
  // cutting there keeps a word out of the title from being read as the author.
  const head = yearMatch ? input.slice(0, yearMatch.index) : input;
  const words = [...head.matchAll(WORD_RE)].map((m) => m[0]);

  const surname: string[] = [];
  for (const w of words) {
    const lower = w.toLowerCase();
    // Skip whatever leads the line before the name starts. Single letters are
    // initials on a name printed given-name-first ("J Smith").
    if (surname.length === 0 && (w.length < 2 || NOT_A_SURNAME.has(lower))) continue;
    surname.push(w);
    // A particle only ever leads a surname, so keep reading until the word that
    // isn't one ends it. Anything else is the whole surname on its own.
    if (!PARTICLES.has(lower)) break;
  }

  if (surname.length === 0 || year == null) {
    return {
      kind: "unknown",
      input,
      reason:
        year == null && surname.length === 0
          ? "No PMID, DOI, or author and year in this line."
          : year == null
            ? "Found an author but no year."
            : "Found a year but no author name.",
    };
  }

  const author = surname.join(" ");
  return {
    kind: "citation",
    input,
    author,
    authorKey: surname[surname.length - 1].toLowerCase(),
    year,
  };
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
