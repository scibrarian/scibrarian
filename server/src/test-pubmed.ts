import { beforeEach } from "vitest";
import type { ArticleInsert } from "./db.js";
import type * as Real from "./pubmed.js";
import type * as Self from "./test-pubmed.js";
import type { ArticleMeta, ArticleXml } from "./pubmed-parse.js";
import { safeError } from "./util.js";

// PubMed for tests: an in-memory stand-in for pubmed.ts, which talks to NCBI.
// A test mocks the module with this one and tells it what PubMed holds:
//
//   vi.mock("./pubmed.js", () => import("./test-pubmed.js"));
//   import { pubmed } from "./test-pubmed.js";
//
// It answers every export pubmed.ts has, so nothing a test didn't think to fake
// falls through to the real one, and it answers them from one set of records:
// the DOI a paper is looked up by is the DOI its fetched record carries, and a
// paper PubMed doesn't hold is missing from every answer alike. Left alone it is
// a PubMed that holds nothing and matches nothing.
//
// The static import is what empties it before each test: loading it registers
// the beforeEach below. A file that only mocks with it and sets nothing needs no
// import.
//
// What it doesn't do is search. A search answers whatever the test said a term
// containing some key answers (answer()), because building the term is the
// code under test's business, and pubmed.test pins the requests themselves.

type Calls = {
  [K in keyof typeof Real]: (typeof Real)[K] extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof typeof Real];
type Args<K extends Calls> = Parameters<(typeof Real)[K]>;

const records = new Map<string, ArticleInsert>();
const answers = new Map<string, { ids: string[]; total: number }>();
const holds = new Map<Calls, Promise<unknown>>();
let log: { fn: Calls; args: unknown[] }[] = [];

export const pubmed = {
  /** The records PubMed holds. Every fetch, and every lookup by DOI, answers from these. */
  add(...found: ArticleInsert[]): void {
    for (const a of found) records.set(a.pmid, a);
  },
  /** What a search answers: the first key, in the order given, that its term contains. */
  answer(key: string, ids: string[], total = ids.length): void {
    answers.set(key, { ids, total });
  },
  /** NLM's list of MEDLINE journals: indexed now (true) or once (false), by NLM id. */
  medline: new Map<string, boolean>(),
  /** PubMed is down: every call fails as pubmed.ts does when it can't reach NCBI. */
  fail: false,
  /** Every call to `fn` from now on waits on `until` after it is recorded, and throws if it rejects. */
  hold(fn: Calls, until: Promise<unknown>): void {
    until.catch(() => {}); // a rejection nobody is waiting on yet isn't unhandled
    holds.set(fn, until);
  },
  /** The arguments of each call to `fn` so far, in order. */
  calls<K extends Calls>(fn: K): Args<K>[] {
    return log.filter((c) => c.fn === fn).map((c) => c.args as Args<K>);
  },
  /** Drops the calls made so far, for a test that asks about the next ones. */
  forgetCalls(): void {
    log = [];
  },
};

beforeEach(() => {
  records.clear();
  answers.clear();
  holds.clear();
  log = [];
  pubmed.medline = new Map();
  pubmed.fail = false;
});

// The endpoint each call asks first, for the outage message pubmed.ts writes.
const ENDPOINT: Record<Calls, string> = {
  searchWithTotal: "esearch.fcgi",
  searchRecent: "esearch.fcgi",
  countMatches: "esearch.fcgi",
  pmidsForDoi: "esearch.fcgi",
  resolveDoiToPmid: "esearch.fcgi",
  fetchSummaries: "esummary.fcgi",
  fetchJournalIds: "esummary.fcgi",
  fetchArticleXml: "efetch.fcgi",
  fetchArticles: "esummary.fcgi",
  isMedlineIndexed: "esearch.fcgi",
  fetchMedlineIndexing: "esearch.fcgi",
};

async function asked<K extends Calls>(fn: K, args: Args<K>): Promise<void> {
  log.push({ fn, args });
  await holds.get(fn);
  if (pubmed.fail) throw safeError(`Couldn't reach PubMed (${ENDPOINT[fn]}). Try again in a minute.`);
}

function answerFor(term: string): { ids: string[]; total: number } {
  for (const [key, found] of answers) {
    if (term.includes(key)) return { ids: [...found.ids], total: found.total };
  }
  return { ids: [], total: 0 };
}

// At most two, as pubmed.ts asks for: one is an answer, a second shows there isn't one.
function pmidsWithDoi(doi: string): string[] {
  const wanted = doi.toLowerCase();
  return [...records.values()]
    .filter((a) => a.doi.toLowerCase() === wanted)
    .slice(0, 2)
    .map((a) => a.pmid);
}

const held = (pmids: string[]) =>
  pmids.flatMap((p) => {
    const found = records.get(p);
    return found ? [found] : [];
  });

export { buildTerm, topicTerm } from "./pubmed-parse.js";

// pubmed.ts's own, so a test sees the batches production makes.
export const EUTILS_BATCH = 100;

export const searchWithTotal: typeof Real.searchWithTotal = async (...args) => {
  await asked("searchWithTotal", args);
  return answerFor(args[0]);
};

export const searchRecent: typeof Real.searchRecent = async (...args) => {
  await asked("searchRecent", args);
  return answerFor(args[0]).ids.slice(0, args[1]);
};

export const countMatches: typeof Real.countMatches = async (...args) => {
  await asked("countMatches", args);
  return answerFor(args[0]).total;
};

export const pmidsForDoi: typeof Real.pmidsForDoi = async (...args) => {
  await asked("pmidsForDoi", args);
  return pmidsWithDoi(args[0]);
};

export const resolveDoiToPmid: typeof Real.resolveDoiToPmid = async (...args) => {
  await asked("resolveDoiToPmid", args);
  const ids = pmidsWithDoi(args[0]);
  return ids.length === 1 ? ids[0] : null;
};

export const fetchSummaries: typeof Real.fetchSummaries = async (...args) => {
  await asked("fetchSummaries", args);
  return new Map(
    held(args[0]).map((a): [string, ArticleMeta] => [
      a.pmid,
      {
        pmid: a.pmid,
        title: a.title,
        journal_name: a.journal_name,
        authors: a.authors,
        pub_date: a.pub_date,
        pub_date_display: a.pub_date_display,
        doi: a.doi,
      },
    ])
  );
};

export const fetchJournalIds: typeof Real.fetchJournalIds = async (...args) => {
  await asked("fetchJournalIds", args);
  return held(args[0]).flatMap((a) => (a.nlm_id ? [a.nlm_id] : []));
};

export const fetchArticleXml: typeof Real.fetchArticleXml = async (...args) => {
  await asked("fetchArticleXml", args);
  return new Map(
    held(args[0]).map((a): [string, ArticleXml] => [
      a.pmid,
      {
        abstract: a.abstract,
        nlmId: a.nlm_id ?? "",
        medlineTa: "",
        mesh: a.mesh?.headings ?? [],
        status: a.mesh?.status ?? "",
        pubTypes: a.pubTypes ?? [],
      },
    ])
  );
};

export const fetchArticles: typeof Real.fetchArticles = async (...args) => {
  await asked("fetchArticles", args);
  return held(args[0]).map((a) => ({ ...a }));
};

// Best-effort in pubmed.ts too: an outage is "couldn't tell", never a failure.
export const isMedlineIndexed: typeof Real.isMedlineIndexed = async (...args) => {
  log.push({ fn: "isMedlineIndexed", args });
  await holds.get("isMedlineIndexed");
  return pubmed.fail ? null : (pubmed.medline.get(args[0]) ?? null);
};

export const fetchMedlineIndexing: typeof Real.fetchMedlineIndexing = async (...args) => {
  await asked("fetchMedlineIndexing", args);
  if (pubmed.medline.size === 0) throw safeError("NLM's list of MEDLINE journals came back empty.");
  return new Map(pubmed.medline);
};

// Every export pubmed.ts has, typed as it types them: one added there and not
// here fails to compile, rather than leaving a test to find NCBI.
type Covers<Fake extends typeof Real> = Fake;
export type PubmedFake = Covers<typeof Self>;
