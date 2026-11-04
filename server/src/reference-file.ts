import { findDoi, labelledPmid } from "./identifiers.js";

// Read a reference manager's export into the entries a bookmark folder import
// looks up: RIS, which EndNote, Zotero and Mendeley all write, and PubMed's own
// MEDLINE format, which is what its "Send to → Citation manager" saves as .nbib.
//
// Only what the lookup and the unmatched list need is read out of an entry: a
// PMID or a DOI to find it on PubMed by, and its title, authors, journal and
// year to show beside the box where a PMID can be typed for one that wasn't
// found. Everything else in the record is PubMed's to supply once it is found.
//
// Pure and tested, like citation-ref.ts. What it decides — which number in a
// record is a PMID — is the difference between an entry saved as the paper it
// names and one saved as a different paper that really exists.

export type ReferenceFormat = "ris" | "medline";

export interface FileEntry {
  title: string;
  /** Up to three authors as the file wrote them, then "et al." — for display. */
  authors: string;
  journal: string;
  year: string;
  /** Lowercased, as findDois gives it. */
  doi: string | null;
  pmid: string | null;
  /** False when the record's own type says it isn't a journal article. */
  article: boolean;
}

export interface ReferenceFile {
  format: ReferenceFormat;
  entries: FileEntry[];
}

/** The file read into entries, or null when it is neither RIS nor MEDLINE. */
export function parseReferenceFile(text: string): ReferenceFile | null {
  const lines = text.replace(/^﻿/, "").split(/\r\n?|\n/);
  if (lines.some((l) => RIS_TAG_RE.exec(l)?.[1] === "TY")) {
    return { format: "ris", entries: risRecords(lines).map(risEntry) };
  }
  if (lines.some((l) => MEDLINE_PMID_RE.test(l))) {
    return { format: "medline", entries: medlineRecords(lines).map(medlineEntry) };
  }
  return null;
}

// A record's fields, each tag's values in the order they appeared.
type Fields = Map<string, string[]>;

const first = (fields: Fields, ...tags: string[]): string => {
  for (const tag of tags) {
    const value = fields.get(tag)?.find((v) => v !== "");
    if (value) return value;
  }
  return "";
};

const all = (fields: Fields, ...tags: string[]): string[] =>
  tags.flatMap((tag) => fields.get(tag) ?? []).filter((v) => v !== "");

function authorLine(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join("; ")} et al.` : names.join("; ");
}

const YEAR_RE = /\b(1[89]\d{2}|20\d{2})\b/;
const yearOf = (date: string): string => YEAR_RE.exec(date)?.[1] ?? "";

// ---------- RIS ----------

// "TY  - JOUR": two characters, two spaces, a hyphen. Exporters disagree about
// the spaces (one, two) and about the space after the hyphen (an empty field
// like "ER  -" has none), so both are loose. A line that doesn't match carries
// on the field before it: long abstracts and titles get wrapped.
const RIS_TAG_RE = /^([A-Z][A-Z0-9])\s{1,2}-(?: (.*))?$/;

function risRecords(lines: string[]): Fields[] {
  const records: Fields[] = [];
  let fields: Fields | null = null;
  let last: string[] | null = null;
  for (const line of lines) {
    const m = RIS_TAG_RE.exec(line);
    if (!m) {
      if (last && line.trim()) last[last.length - 1] = `${last[last.length - 1]} ${line.trim()}`.trim();
      continue;
    }
    const [, tag, value = ""] = m;
    if (tag === "TY") {
      fields = new Map();
      records.push(fields);
    }
    if (!fields) continue;
    if (tag === "ER") {
      fields = null;
      last = null;
      continue;
    }
    last = fields.get(tag) ?? [];
    last.push(value.trim());
    fields.set(tag, last);
  }
  return records;
}

// The RIS types that are clearly not journal articles: books and their
// chapters, reports, theses, web pages, legal and government documents, media.
// Skipped on import, because the app holds journal literature and nothing else.
//
// A list of what to leave out rather than of what to keep, so that an entry
// whose type is missing, generic (GEN, which EndNote writes for anything it
// wasn't told about) or unfamiliar is still looked up. Conference papers and
// abstracts stay too: journals publish both, and PubMed indexes plenty of them.
const NOT_ARTICLES = new Set([
  "ADVS", "AGGR", "ART", "BILL", "BLOG", "BOOK", "CASE", "CHAP", "CHART", "CLSWK", "COMP",
  "CTLG", "DATA", "DBASE", "DICT", "EBOOK", "ECHAP", "EDBOOK", "ELEC", "ENCYC", "EQUA",
  "FIGURE", "GOVDOC", "GRANT", "HEAR", "ICOMM", "LEGAL", "MAP", "MGZN", "MPCT", "MULTI",
  "MUSIC", "NEWS", "PAMP", "PAT", "PCOMM", "RPRT", "SLIDE", "SOUND", "STAND", "STAT",
  "THES", "VIDEO", "WEB",
]);

// Fields that are prose, where "PMID" or a PubMed address could turn up as part
// of a sentence about some other paper.
const RIS_PROSE = new Set(["AB", "N2", "TI", "T1", "T2", "T3", "KW", "CT", "BT"]);

// The database an accession number belongs to, when the record says.
const PUBMED_DB_RE = /pubmed|medline|\bnlm\b/i;

function risEntry(fields: Fields): FileEntry {
  return {
    title: first(fields, "TI", "T1", "CT", "BT"),
    authors: authorLine(all(fields, "AU", "A1")),
    journal: first(fields, "T2", "JO", "JF", "JA", "J2", "J1"),
    year: yearOf(first(fields, "PY", "Y1", "DA")),
    doi: risDoi(fields),
    pmid: risPmid(fields),
    article: !NOT_ARTICLES.has(first(fields, "TY").toUpperCase()),
  };
}

// The DOI field, and failing that a doi.org address among the record's links.
function risDoi(fields: Fields): string | null {
  for (const value of all(fields, "DO")) {
    const doi = findDoi(value);
    if (doi) return doi;
  }
  for (const value of all(fields, "UR", "L1", "L2", "L3", "L4", "LK")) {
    const doi = findDoi(value);
    if (doi) return doi;
  }
  return null;
}

// RIS has no PMID field, so a record says it has one in one of three ways:
//
//  - a PubMed address among its links or notes, or a value labelled "PMID";
//  - its accession number (AN), when the record names PubMed or MEDLINE as the
//    database it came from (DB, or DP for the provider). EndNote and Zotero
//    both write a PubMed record's PMID there.
//
// An accession number is taken only with that database beside it. Without it
// AN is any database's number — Web of Science's, Embase's, CINAHL's — and
// read as a PMID it names a different paper that really exists.
function risPmid(fields: Fields): string | null {
  for (const [tag, values] of fields) {
    if (RIS_PROSE.has(tag)) continue;
    for (const value of values) {
      const pmid = labelledPmid(value);
      if (pmid) return pmid;
    }
  }
  if (PUBMED_DB_RE.test(all(fields, "DB", "DP").join(" "))) {
    const an = /^\d{1,8}$/.exec(first(fields, "AN"));
    if (an) return an[0];
  }
  return null;
}

// ---------- MEDLINE (PubMed format, .nbib) ----------

// "PMID- 33301246", "TI  - ...", "FAU - ...": a tag padded to four characters,
// a hyphen and a space. Continuation lines are indented six spaces.
const MEDLINE_TAG_RE = /^([A-Z]{2,4})\s*- (.*)$/;
const MEDLINE_PMID_RE = /^PMID- ?\d{1,8}\s*$/;

function medlineRecords(lines: string[]): Fields[] {
  const records: Fields[] = [];
  let fields: Fields | null = null;
  let last: string[] | null = null;
  for (const line of lines) {
    if (MEDLINE_PMID_RE.test(line)) {
      fields = new Map();
      records.push(fields);
    }
    if (!fields) continue;
    const m = MEDLINE_TAG_RE.exec(line);
    if (m) {
      const [, tag, value] = m;
      last = fields.get(tag) ?? [];
      last.push(value.trim());
      fields.set(tag, last);
    } else if (last && line.startsWith(" ") && line.trim()) {
      last[last.length - 1] = `${last[last.length - 1]} ${line.trim()}`;
    }
  }
  return records;
}

// Every record in this format is PubMed's own, with its PMID on a line of its
// own, so nothing here is guessed and nothing is skipped as not an article: the
// record is in PubMed, which is the one thing the import needs to know.
function medlineEntry(fields: Fields): FileEntry {
  // "10.1056/NEJMoa2035389 [doi]" — LID or AID, beside PIIs and PMC ids.
  const doiField = all(fields, "LID", "AID").find((v) => /\[doi\]\s*$/i.test(v));
  return {
    title: first(fields, "TI", "BTI"),
    authors: authorLine(all(fields, "AU")),
    journal: first(fields, "JT", "TA"),
    year: yearOf(first(fields, "DP")),
    doi: doiField ? findDoi(doiField) : null,
    pmid: /^\d{1,8}$/.exec(first(fields, "PMID"))?.[0] ?? null,
    article: true,
  };
}
