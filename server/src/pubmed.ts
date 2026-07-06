import { XMLParser } from "fast-xml-parser";
import { findCatalogByName, getSettings } from "./db.js";
import type { ArticleInsert } from "./db.js";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TOOL = "sciluminate";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  // Keep everything as strings — otherwise an id like "0255562" (NlmUniqueID)
  // is parsed as the number 255562 and loses its leading zero.
  parseTagValue: false,
});

// ---------- request throttling ----------
// NCBI allows ~3 req/sec without an API key, ~10/sec with one. We serialize all
// requests through a single promise chain that enforces a minimum gap.
let chain: Promise<void> = Promise.resolve();
let lastRequest = 0;

function throttle(): Promise<void> {
  // NCBI allows ~3 req/s without a key; 400ms (~2.5/s) leaves margin so we trip
  // the 429 limiter less often. With a key the cap is ~10/s.
  const minGap = getSettings().ncbi_api_key ? 110 : 400;
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

// Transient failures (dropped connections, NCBI 429/5xx) are common across the
// many requests an all-time poll makes. Retry them a few times with exponential
// backoff — honoring Retry-After on 429 — before giving up.
const MAX_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

async function eutilsFetch(endpoint: string, params: URLSearchParams): Promise<Response> {
  const url = `${EUTILS}/${endpoint}?${withCommonParams(params).toString()}`;
  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      // Network-level failure (e.g. "terminated", ECONNRESET, timeout).
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (res.ok) return res;
    if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
      const wait = retryAfterMs(res) ?? backoffMs(attempt);
      await res.arrayBuffer().catch(() => {}); // drain the body to free the socket
      await sleep(wait);
      continue;
    }
    throw new Error(`NCBI ${endpoint} returned ${res.status} ${res.statusText}`);
  }
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

// Resolve a DOI to its PMID via a field-tagged esearch (covers all of PubMed,
// unlike the PMC-only idconv service, and inherits the shared throttle/retry/
// API-key plumbing). Returns null unless PubMed has exactly one match — 0 or
// 2+ hits mean the id can't be trusted.
export async function resolveDoiToPmid(doi: string): Promise<string | null> {
  const params = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    retmax: "2",
    term: `"${doi.replace(/"/g, "")}"[doi]`,
  });
  const res = await eutilsFetch("esearch.fcgi", params);
  const data = (await res.json()) as { esearchresult?: { idlist?: string[] } };
  const ids = data.esearchresult?.idlist ?? [];
  return ids.length === 1 ? ids[0] : null;
}

// Count of PubMed articles in a journal — used to validate a free-typed journal
// name that isn't in the local catalog.
export async function journalCount(journalName: string): Promise<number> {
  const params = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    retmax: "0",
    term: `"${journalName.replace(/"/g, "")}"[Journal]`,
  });
  const res = await eutilsFetch("esearch.fcgi", params);
  const data = (await res.json()) as { esearchresult?: { count?: string } };
  return Number(data.esearchresult?.count ?? 0);
}

// ---------- esummary (metadata) ----------

interface ESummaryDoc {
  uid: string;
  error?: string; // present when PubMed has no such PMID
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

// ---------- efetch (abstract + journal identity) ----------

interface ArticleXml {
  abstract: string;
  nlmId: string; // NLM Unique journal ID — the stable journal identity
  medlineTa: string; // NLM journal abbreviation
}

// The efetch XML carries the journal's NlmUniqueID/MedlineTA per article, so we
// get a rock-solid journal identifier for free alongside the abstract.
export async function fetchArticleXml(pmids: string[]): Promise<Map<string, ArticleXml>> {
  const out = new Map<string, ArticleXml>();
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
  for (const art of asArray(set.PubmedArticle)) {
    const pmid = getPmid(art);
    if (!pmid) continue;
    const info = art?.MedlineCitation?.MedlineJournalInfo;
    out.set(pmid, {
      abstract: parseAbstract(art),
      nlmId: nodeValue(info?.NlmUniqueID),
      medlineTa: nodeValue(info?.MedlineTA),
    });
  }
  return out;
}

// ---------- combine: fetch full article records for new PMIDs ----------

export async function fetchArticles(pmids: string[]): Promise<ArticleInsert[]> {
  const [meta, xmlData] = await Promise.all([fetchSummaries(pmids), fetchArticleXml(pmids)]);
  const articles: ArticleInsert[] = [];
  for (const pmid of pmids) {
    const m = meta.get(pmid);
    if (!m) continue; // no metadata -> skip
    const x = xmlData.get(pmid);
    articles.push({
      pmid,
      title: m.title,
      abstract: x?.abstract ?? "",
      journal_name: m.journal_name,
      nlm_id: x?.nlmId || null,
      authors: m.authors,
      pub_date: m.pub_date,
      pub_date_display: m.pub_date_display,
      doi: m.doi,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    });
  }
  return articles;
}

// Resolve a user-entered journal name to its stable NLM id + display abbreviation.
// Prefers the local catalog; otherwise a one-shot PubMed lookup (which also
// validates — no article means PubMed doesn't recognize the name).
export async function resolveJournal(
  rawName: string
): Promise<{ nlmId: string; name: string } | null> {
  const cat = findCatalogByName(rawName);
  if (cat) return { nlmId: cat.nlm_id, name: cat.med_abbr || cat.title };

  const params = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    retmax: "1",
    term: `"${rawName.replace(/"/g, "")}"[Journal]`,
  });
  const res = await eutilsFetch("esearch.fcgi", params);
  const data = (await res.json()) as { esearchresult?: { idlist?: string[] } };
  const pmid = data.esearchresult?.idlist?.[0];
  if (!pmid) return null; // PubMed doesn't recognize this journal name
  const x = (await fetchArticleXml([pmid])).get(pmid);
  if (!x?.nlmId) return null;
  return { nlmId: x.nlmId, name: x.medlineTa || rawName };
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
