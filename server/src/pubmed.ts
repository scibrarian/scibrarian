import { findCatalogByName, getSettings } from "./db.js";
import type { ArticleInsert } from "./db.js";
import { parseArticleSet, parseJournalIds, parseSummaries } from "./pubmed-parse.js";
import type { ArticleMeta, ArticleXml } from "./pubmed-parse.js";

// Fetch/throttle/retry side of the PubMed client; response parsing and query
// building live in pubmed-parse.ts (pure, tested against fixtures).
export { buildTerm } from "./pubmed-parse.js";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TOOL = "scibrarian";

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

// ---------- esearch ----------

// Fetch matching PMIDs. A single esearch caps at 10k ids, so we page with
// retstart; MAX_RESULTS is a safety ceiling so an overly broad term can't pull
// an unbounded set.
//
// `mhdaSince` (YYYY/MM/DD) bounds the query by MeSH Date [mhda] — the date a
// citation was indexed with MeSH (which equals its Entrez date until it's
// indexed). An incremental poll passes the last-poll date so PubMed returns only
// what became matchable since then: brand-new papers *and* older ones PubMed
// only just assigned MeSH. The latter (old add-date, recent MeSH date) are a
// large share of results — verified ~47% for a sample MeSH topic — that an
// add-date (edat) window would silently miss. Omit it to scan the full history
// (a topic's first poll).
const PAGE = 1000;
const MAX_RESULTS = 10000;

export async function search(term: string, mhdaSince?: string): Promise<string[]> {
  const q = mhdaSince ? `(${term}) AND (${mhdaSince}:3000[mhda])` : term;
  const ids: string[] = [];
  let retstart = 0;
  let total = Infinity;
  while (ids.length < Math.min(total, MAX_RESULTS)) {
    const params = new URLSearchParams({
      db: "pubmed",
      retmode: "json",
      sort: "pub_date",
      retmax: String(PAGE),
      retstart: String(retstart),
      term: q,
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

// The most recent `retmax` PMIDs for a term, published on/after `mindate`
// (YYYY/MM/DD). One bounded request — unlike search(), which pages through a
// topic's complete history for polling — because journal-frequency ranking
// (journal-suggest.ts) only needs a recent sample, not completeness.
export async function searchRecent(
  term: string,
  retmax: number,
  mindate: string
): Promise<string[]> {
  const params = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    sort: "pub_date",
    retmax: String(retmax),
    datetype: "pdat",
    mindate,
    maxdate: "3000", // mindate is ignored unless maxdate is also present
    term,
  });
  const res = await eutilsFetch("esearch.fcgi", params);
  const data = (await res.json()) as { esearchresult?: { idlist?: string[] } };
  return data.esearchresult?.idlist ?? [];
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

// ---------- esummary (metadata) ----------

export async function fetchSummaries(pmids: string[]): Promise<Map<string, ArticleMeta>> {
  if (pmids.length === 0) return new Map();
  const params = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    id: pmids.join(","),
  });
  const res = await eutilsFetch("esummary.fcgi", params);
  return parseSummaries(pmids, await res.json());
}

// Journal NLM ids for a batch of PMIDs (one per article, repeats intact) — the
// lean esummary variant journal-frequency ranking needs; full article metadata
// isn't parsed or returned.
export async function fetchJournalIds(pmids: string[]): Promise<string[]> {
  if (pmids.length === 0) return [];
  const params = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    id: pmids.join(","),
  });
  const res = await eutilsFetch("esummary.fcgi", params);
  return parseJournalIds(await res.json());
}

// ---------- efetch (abstract + journal identity) ----------

export async function fetchArticleXml(pmids: string[]): Promise<Map<string, ArticleXml>> {
  if (pmids.length === 0) return new Map();
  const params = new URLSearchParams({
    db: "pubmed",
    rettype: "abstract",
    retmode: "xml",
    id: pmids.join(","),
  });
  const res = await eutilsFetch("efetch.fcgi", params);
  return parseArticleSet(await res.text());
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
