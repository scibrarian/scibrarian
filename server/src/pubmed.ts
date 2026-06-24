import { XMLParser } from "fast-xml-parser";
import { getSettings } from "./db.js";
import type { ArticleInsert } from "./db.js";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TOOL = "research-timeline";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
});

// ---------- request throttling ----------
// NCBI allows ~3 req/sec without an API key, ~10/sec with one. We serialize all
// requests through a single promise chain that enforces a minimum gap.
let chain: Promise<void> = Promise.resolve();
let lastRequest = 0;

function throttle(): Promise<void> {
  const minGap = getSettings().ncbi_api_key ? 110 : 350;
  const run = chain.then(async () => {
    const wait = minGap - (Date.now() - lastRequest);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
  });
  // Keep the chain alive even if a caller's downstream work rejects.
  chain = run.catch(() => undefined);
  return run;
}

function withCommonParams(params: URLSearchParams): URLSearchParams {
  const { ncbi_api_key, ncbi_email } = getSettings();
  params.set("tool", TOOL);
  if (ncbi_email) params.set("email", ncbi_email);
  if (ncbi_api_key) params.set("api_key", ncbi_api_key);
  return params;
}

async function eutilsFetch(endpoint: string, params: URLSearchParams): Promise<Response> {
  await throttle();
  const url = `${EUTILS}/${endpoint}?${withCommonParams(params).toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NCBI ${endpoint} returned ${res.status} ${res.statusText}`);
  }
  return res;
}

// ---------- query building ----------

export function buildTerm(diseaseTerm: string, journalNames: string[]): string {
  const term = diseaseTerm.trim();
  if (journalNames.length === 0) return term;
  const journalClause = journalNames
    .map((n) => `"${n.replace(/"/g, "")}"[Journal]`)
    .join(" OR ");
  return `(${term}) AND (${journalClause})`;
}

// ---------- esearch ----------

// Fetch *all* matching PMIDs (no date filter — full history), newest first.
// A single esearch caps at 10k ids, so we page with retstart; MAX_RESULTS is a
// safety ceiling so an overly broad term can't pull an unbounded set.
const PAGE = 1000;
const MAX_RESULTS = 10000;

export async function search(term: string): Promise<string[]> {
  const ids: string[] = [];
  let retstart = 0;
  let total = Infinity;
  while (ids.length < Math.min(total, MAX_RESULTS)) {
    const params = new URLSearchParams({
      db: "pubmed",
      retmode: "json",
      sort: "date",
      retmax: String(PAGE),
      retstart: String(retstart),
      term,
    });
    const res = await eutilsFetch("esearch.fcgi", params);
    const data = (await res.json()) as {
      esearchresult?: { idlist?: string[]; count?: string };
    };
    const idlist = data.esearchresult?.idlist ?? [];
    total = Number(data.esearchresult?.count ?? ids.length + idlist.length);
    if (idlist.length === 0) break;
    ids.push(...idlist);
    retstart += idlist.length;
  }
  return ids.slice(0, MAX_RESULTS);
}

// ---------- esummary (metadata) ----------

interface ESummaryDoc {
  uid: string;
  title?: string;
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  epubdate?: string;
  sortpubdate?: string;
  elocationid?: string;
  authors?: { name: string; authtype?: string }[];
  articleids?: { idtype: string; value: string }[];
}

interface ArticleMeta {
  pmid: string;
  title: string;
  journal_name: string;
  authors: string[];
  pub_date: string;
  pub_date_display: string;
  doi: string;
}

export async function fetchSummaries(pmids: string[]): Promise<Map<string, ArticleMeta>> {
  const out = new Map<string, ArticleMeta>();
  if (pmids.length === 0) return out;
  const params = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    id: pmids.join(","),
  });
  const res = await eutilsFetch("esummary.fcgi", params);
  const data = (await res.json()) as { result?: Record<string, ESummaryDoc | string[]> };
  const result = data.result;
  if (!result) return out;
  for (const pmid of pmids) {
    const doc = result[pmid] as ESummaryDoc | undefined;
    if (!doc || typeof doc !== "object") continue;
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

// ---------- efetch (abstracts) ----------

export async function fetchAbstracts(pmids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (pmids.length === 0) return out;
  const params = new URLSearchParams({
    db: "pubmed",
    rettype: "abstract",
    retmode: "xml",
    id: pmids.join(","),
  });
  const res = await eutilsFetch("efetch.fcgi", params);
  const text = await res.text();
  const parsed = xml.parse(text);
  const set = parsed?.PubmedArticleSet;
  if (!set) return out;
  const articles = asArray(set.PubmedArticle);
  for (const art of articles) {
    const pmid = getPmid(art);
    if (!pmid) continue;
    out.set(pmid, parseAbstract(art));
  }
  return out;
}

// ---------- combine: fetch full article records for new PMIDs ----------

export async function fetchArticles(pmids: string[]): Promise<ArticleInsert[]> {
  const [meta, abstracts] = await Promise.all([fetchSummaries(pmids), fetchAbstracts(pmids)]);
  const articles: ArticleInsert[] = [];
  for (const pmid of pmids) {
    const m = meta.get(pmid);
    if (!m) continue; // no metadata -> skip
    articles.push({
      pmid,
      title: m.title,
      abstract: abstracts.get(pmid) ?? "",
      journal_name: m.journal_name,
      authors: m.authors,
      pub_date: m.pub_date,
      pub_date_display: m.pub_date_display,
      doi: m.doi,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    });
  }
  return articles;
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

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Parse a PubMed date into "YYYY-MM-DD". Handles both the numeric sort form
// ("2026/12/20 00:00") and the display form with a month name ("2025 Nov 20",
// "2025 Nov", "2025"); tolerates partial dates. Returns "" when no year is found.
function parsePubDate(raw: string | undefined): string {
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

// Choose the date a paper actually became available. Journals routinely stamp a
// *future* print-issue date (pubdate/sortpubdate) on a paper that is already out
// online (epubdate); using that date pushes the paper to the top of the timeline
// with a date in the future. We take the earliest real date and report the
// matching human-readable string — which is also what PubMed itself displays.
// (e.g. PMID 41275875: print "2026 Dec 20" vs online "2025 Nov 20".)
function pickPubDate(doc: ESummaryDoc): { sort: string; display: string } {
  const candidates = [
    { sort: parsePubDate(doc.epubdate), display: (doc.epubdate ?? "").trim() },
    {
      sort: parsePubDate(doc.sortpubdate) || parsePubDate(doc.pubdate),
      display: (doc.pubdate ?? "").trim(),
    },
  ].filter((c) => c.sort);
  candidates.sort((a, b) => a.sort.localeCompare(b.sort));
  const chosen = candidates[0];
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
