import { XMLParser } from "fast-xml-parser";
import type { MeshHeading } from "../../shared/types.js";

// Pure parsing and query-building for PubMed E-utilities responses. No I/O and
// no imports from db/config, so tests can feed fixture payloads directly;
// pubmed.ts owns the fetch/throttle/retry side and re-exports the public bits.

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  // Keep everything as strings — otherwise an id like "0255562" (NlmUniqueID)
  // is parsed as the number 255562 and loses its leading zero.
  parseTagValue: false,
  // Decode numeric character references (&#60;, &#x2265;) as well as the five
  // predefined named ones. PubMed abstracts are full of them — "p&#60;0.05",
  // "10&#xB1;2" — and without this they reach the DB and the UI as raw escapes,
  // which also breaks the abstract LIKE search (db.ts). Off by default, so the
  // predefined entities were the only ones decoded.
  htmlEntities: true,
});

// ---------- query building ----------

export function buildTerm(topicTerm: string, journalNames: string[]): string {
  const term = topicTerm.trim();
  if (journalNames.length === 0) return term;
  const journalClause = journalNames
    .map((n) => `"${n.replace(/"/g, "")}"[Journal]`)
    .join(" OR ");
  return `(${term}) AND (${journalClause})`;
}

// ---------- esummary (metadata) ----------

interface ESummaryDoc {
  uid: string;
  error?: string; // present when PubMed has no such PMID
  title?: string;
  fulljournalname?: string;
  source?: string;
  nlmuniqueid?: string; // NLM Unique journal ID — the stable journal identity
  pubdate?: string;
  epubdate?: string;
  sortpubdate?: string;
  elocationid?: string;
  authors?: { name: string; authtype?: string }[];
  articleids?: { idtype: string; value: string }[];
}

export interface ArticleMeta {
  pmid: string;
  title: string;
  journal_name: string;
  authors: string[];
  pub_date: string;
  pub_date_display: string;
  doi: string;
}

// Parse an esummary.fcgi JSON body for the requested pmids.
export function parseSummaries(pmids: string[], body: unknown): Map<string, ArticleMeta> {
  const out = new Map<string, ArticleMeta>();
  const result = (body as { result?: Record<string, ESummaryDoc | string[]> })?.result;
  if (!result) return out;
  for (const pmid of pmids) {
    const doc = result[pmid] as ESummaryDoc | undefined;
    if (!doc || typeof doc !== "object") continue;
    // PubMed returns an error stub ({uid, error}) for ids it doesn't have; skip
    // it so a nonexistent/garbage PMID never becomes an empty article record.
    if (doc.error) continue;
    const { sort: pubDate, display: pubDateDisplay } = pickPubDate(doc);
    out.set(pmid, {
      pmid,
      title: cleanTitle(doc.title ?? ""),
      journal_name: doc.fulljournalname || doc.source || "",
      authors: (doc.authors ?? [])
        .filter((a) => !a.authtype || a.authtype === "Author")
        .map((a) => a.name),
      pub_date: pubDate,
      pub_date_display: pubDateDisplay,
      doi: extractDoi(doc),
    });
  }
  return out;
}

// Pull each doc's journal NLM id from an esummary body, one entry per article
// (repeats intact — journal-frequency ranking counts them; see
// journal-suggest.ts). Error stubs and docs without an id are skipped.
export function parseJournalIds(body: unknown): string[] {
  const result = (body as { result?: Record<string, ESummaryDoc | string[]> })?.result;
  if (!result) return [];
  const uids = Array.isArray(result.uids) ? result.uids : [];
  const out: string[] = [];
  for (const uid of uids) {
    const doc = result[uid];
    if (!doc || Array.isArray(doc) || typeof doc !== "object") continue;
    if (doc.error || !doc.nlmuniqueid) continue;
    out.push(doc.nlmuniqueid);
  }
  return out;
}

// ---------- efetch (abstract + journal identity + MeSH filing) ----------

export interface ArticleXml {
  abstract: string;
  nlmId: string; // NLM Unique journal ID — the stable journal identity
  medlineTa: string; // NLM journal abbreviation
  mesh: MeshHeading[]; // [] when the record carries no MeshHeadingList
  status: string; // MedlineCitation/@Status verbatim; "" when absent
}

// Parse an efetch.fcgi XML body (rettype=abstract). The XML carries the
// journal's NlmUniqueID/MedlineTA per article, so we get a rock-solid journal
// identifier for free alongside the abstract — and the MeSH headings NLM filed
// the paper under, which is the whole of automatic filing at no extra request.
export function parseArticleSet(xmlText: string): Map<string, ArticleXml> {
  const out = new Map<string, ArticleXml>();
  const parsed = xml.parse(xmlText);
  const set = parsed?.PubmedArticleSet;
  if (!set) return out;
  for (const art of asArray(set.PubmedArticle)) {
    const pmid = getPmid(art);
    if (!pmid) continue;
    const citation = (art as any)?.MedlineCitation;
    const info = citation?.MedlineJournalInfo;
    out.set(pmid, {
      abstract: parseAbstract(art),
      nlmId: nodeValue(info?.NlmUniqueID),
      medlineTa: nodeValue(info?.MedlineTA),
      mesh: parseMeshHeadings(citation),
      status: String(citation?.["@_Status"] ?? "").trim(),
    });
  }
  return out;
}

// ---------- MeSH filing status ----------

// What a MedlineCitation/@Status says about a record's MeSH headings. The
// distinction the library depends on is "this paper will never have headings"
// versus "they haven't arrived yet" — without it, a library holding non-MEDLINE
// papers looks permanently half-filed and there is no way to tell which rows are
// worth asking PubMed about again.
export type MeshOutlook =
  | "indexed" // NLM finished indexing it; its headings (or lack of them) are final
  | "pending" // in PubMed, not yet through MeSH indexing — ask again later
  | "none" // PubMed holds it but MEDLINE never will, so no headings are coming
  | "unknown"; // we have not looked yet

// Statuses that settle the question for good, so a record carrying one is never
// re-fetched. Exported because db.ts buckets stored rows by the same vocabulary
// in SQL and the two must not drift; everything outside this set is treated as
// still in flight, which is the safe direction for a status NLM adds later.
export const MESH_SETTLED_STATUSES = [
  "MEDLINE",
  "OLDMEDLINE",
  "Completed",
  "PubMed-not-MEDLINE",
] as const;

// The one settled status that means no headings will ever exist.
const MESH_STATUS_NEVER = "PubMed-not-MEDLINE";

// Our own marker, not PubMed's, for a record efetch didn't return (a PMID
// withdrawn from PubMed, a response that omitted it) or returned without a
// Status. Deliberately outside MESH_SETTLED_STATUSES so it reads as "pending"
// and is retried on the next recheck window rather than written off — a missing
// record is as likely to be a transient upstream gap as a permanent one. It
// still has to be *stored*, or the row would have no status, stay on the
// backfill's work list, and be re-fetched forever.
export const MESH_STATUS_UNAVAILABLE = "Unavailable";

export function meshOutlook(status: string): MeshOutlook {
  if (!status) return "unknown";
  if (status === MESH_STATUS_NEVER) return "none";
  return (MESH_SETTLED_STATUSES as readonly string[]).includes(status) ? "indexed" : "pending";
}

// ---------- helpers ----------

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function getPmid(article: any): string {
  const node = article?.MedlineCitation?.PMID;
  if (node == null) return "";
  if (typeof node === "object") return String(node["#text"] ?? "");
  return String(node);
}

// Text of a possibly-attributed XML node (fast-xml-parser stores text as #text).
function nodeValue(node: any): string {
  if (node == null) return "";
  if (typeof node === "object") return String(node["#text"] ?? "").trim();
  return String(node).trim();
}

function nodeText(node: any): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(" ");
  const parts: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("@_")) continue;
    parts.push(nodeText(v));
  }
  return parts.join(" ");
}

function parseAbstract(article: any): string {
  const abs = article?.MedlineCitation?.Article?.Abstract?.AbstractText;
  if (abs == null) return "";
  const arr = asArray(abs);
  const sections = arr.map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const label = (item as any)["@_Label"];
      const text = nodeText(item);
      return label ? `${label}: ${text}` : text;
    }
    return nodeText(item);
  });
  return sections.join("\n\n").replace(/[ \t]+/g, " ").trim();
}

function cleanTitle(t: string): string {
  // esummary titles sometimes carry trailing punctuation/markup artifacts.
  return t.replace(/\s+/g, " ").trim();
}

// An XML boolean attribute ("Y"/"N").
function isYes(v: unknown): boolean {
  return String(v ?? "").trim().toUpperCase() === "Y";
}

// The MeSH descriptors one MedlineCitation is filed under.
//
//   <MeshHeadingList>
//     <MeshHeading>
//       <DescriptorName UI="D003924" MajorTopicYN="N">Diabetes Mellitus, Type 2</DescriptorName>
//       <QualifierName UI="Q000188" MajorTopicYN="Y">drug therapy</QualifierName>
//     </MeshHeading>
//   </MeshHeadingList>
//
// Qualifiers ("/drug therapy") are deliberately dropped: they multiply the rows
// per paper severalfold to describe an *aspect* of a subject, and what filing
// needs is the subject. The star does survive them, though — PubMed writes it on
// the descriptor or on any one of its qualifiers, and its own [majr] search
// counts either, so a heading starred only through a qualifier is still major
// here. Losing that would silently demote a large share of exactly the headings
// a paper is most about.
//
// Keyed by UI so a record that repeated a descriptor collapses to one row (the
// article_mesh primary key is (pmid, ui)) with the star OR'd across the
// duplicates rather than decided by whichever came last.
function parseMeshHeadings(citation: any): MeshHeading[] {
  const headings = new Map<string, MeshHeading>();
  for (const h of asArray(citation?.MeshHeadingList?.MeshHeading)) {
    const descriptor = (h as any)?.DescriptorName;
    if (!descriptor) continue;
    const ui = String(descriptor["@_UI"] ?? "").trim();
    const name = nodeValue(descriptor);
    if (!ui || !name) continue;
    const major =
      isYes(descriptor["@_MajorTopicYN"]) ||
      asArray((h as any).QualifierName).some((q) => isYes((q as any)?.["@_MajorTopicYN"]));
    const existing = headings.get(ui);
    if (existing) existing.major ||= major;
    else headings.set(ui, { ui, name, major });
  }
  return [...headings.values()];
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Parse a PubMed date into "YYYY-MM-DD". Handles both the numeric sort form
// ("2026/12/20 00:00") and the display form with a month name ("2025 Nov 20",
// "2025 Nov", "2025"); tolerates partial dates. Returns "" when no year is found.
export function parsePubDate(raw: string | undefined): string {
  if (!raw) return "";
  const s = raw.trim();
  // The month-name form must be tried first: the numeric regex would otherwise
  // match just the year in "2025 Nov 20" and silently drop the month/day.
  const named = s.match(/^(\d{4})\s+([A-Za-z]{3})[A-Za-z]*(?:\s+(\d{1,2}))?/);
  if (named) {
    const mm = MONTHS[named[2].toLowerCase()];
    if (mm) return `${named[1]}-${mm}-${(named[3] ?? "1").padStart(2, "0")}`;
  }
  const numeric = s.match(/^(\d{4})(?:\/(\d{1,2}))?(?:\/(\d{1,2}))?/);
  if (numeric) {
    const month = (numeric[2] ?? "1").padStart(2, "0");
    const day = (numeric[3] ?? "1").padStart(2, "0");
    return `${numeric[1]}-${month}-${day}`;
  }
  return "";
}

// Choose the date a paper actually became available. We prefer the electronic
// (online) publication date — epubdate — which is when the research first
// appeared, and fall back to the print/issue date only when there's no e-pub
// date. This also dodges a trap: journals routinely stamp a *future* print-issue
// date (pubdate/sortpubdate) on a paper that is already out online, which would
// otherwise push it to the top of the timeline with a date in the future.
// (e.g. PMID 41275875: print "2026 Dec 20" vs online "2025 Nov 20".)
function pickPubDate(doc: ESummaryDoc): { sort: string; display: string } {
  const epub = { sort: parsePubDate(doc.epubdate), display: (doc.epubdate ?? "").trim() };
  const print = {
    sort: parsePubDate(doc.sortpubdate) || parsePubDate(doc.pubdate),
    display: (doc.pubdate ?? "").trim(),
  };
  const chosen = epub.sort ? epub : print.sort ? print : null;
  return {
    sort: chosen?.sort ?? "",
    display: chosen?.display || (doc.pubdate ?? "").trim() || (doc.epubdate ?? "").trim(),
  };
}

function extractDoi(doc: ESummaryDoc): string {
  const fromIds = doc.articleids?.find((a) => a.idtype === "doi")?.value;
  if (fromIds) return fromIds;
  const m = doc.elocationid?.match(/10\.\S+/);
  return m ? m[0] : "";
}
