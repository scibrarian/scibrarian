import cron, { ScheduledTask } from "node-cron";
import { DEFAULT_POLL_CRON } from "./config.js";
import {
  db,
  existingPmids,
  getDisease,
  getSettings,
  listDiseases,
  listJournals,
  saveArticles,
  setDiseaseLastPolled,
  transaction,
} from "./db.js";
import { ensureCitations } from "./icite.js";
import { buildTerm, fetchArticles, search } from "./pubmed.js";
import type { PollResult } from "./types.js";
import { chunk, errMessage } from "./util.js";

const BATCH_SIZE = 100;

// Link existing articles to a disease without refetching them from PubMed.
// Returns how many links were newly created — INSERT OR IGNORE reports 0
// changes for a (pmid, disease) row that already existed — so a poll can count
// these toward its "added" delta.
const linkStmt = db.prepare(
  "INSERT OR IGNORE INTO article_diseases (pmid, disease_id) VALUES (?, ?)"
);
const linkKnown = transaction((pmids: string[], diseaseId: number): number => {
  let linked = 0;
  for (const pmid of pmids) linked += Number(linkStmt.run(pmid, diseaseId).changes);
  return linked;
});

// Warm the citation cache for newly added papers so the graph view doesn't
// have to fetch them on first load. Scoped to the caller's delta (a poll or a
// collection import). Best-effort: never throws, so a slow/failing iCite can't
// fail an otherwise successful run.
export async function warmCitations(pmids: string[], label: string): Promise<void> {
  try {
    await ensureCitations(pmids);
  } catch (err) {
    console.warn(
      `[warm] ${label}: citation warm-up failed (will backfill on graph load): ${errMessage(err)}`
    );
  }
}

// The lower bound for a poll's MeSH-date window, as PubMed's YYYY/MM/DD. Start a
// day before the last poll so an ET-vs-UTC boundary or same-day indexing can't
// slip a record through the seam; re-listing a day is idempotent (insert dedup).
function mhdaWindowStart(lastPolledIso: string): string {
  const d = new Date(lastPolledIso);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "/");
}

export async function pollDisease(id: number): Promise<PollResult> {
  const disease = getDisease(id);
  if (!disease) {
    return { diseaseId: id, diseaseName: `#${id}`, found: 0, added: 0, error: "Disease not found" };
  }
  const result: PollResult = { diseaseId: id, diseaseName: disease.name, found: 0, added: 0 };
  try {
    const journals = listJournals().map((j) => j.name);
    const term = buildTerm(disease.term, journals);

    // Incremental poll: ask PubMed only for papers whose MeSH Date lands since
    // the last successful poll, instead of re-listing the topic's whole history
    // every time. That still catches older papers PubMed only just indexed with
    // MeSH (see search). The first poll (no watermark) omits the bound and scans
    // everything to seed the topic.
    const mhdaSince = disease.last_polled_at ? mhdaWindowStart(disease.last_polled_at) : undefined;
    const pmids = await search(term, mhdaSince);
    result.found = pmids.length;

    const known = existingPmids(pmids);
    const newPmids = pmids.filter((p) => !known.has(p));

    const savedPmids: string[] = [];
    for (const batch of chunk(newPmids, BATCH_SIZE)) {
      const articles = await fetchArticles(batch);
      saveArticles(articles, id);
      savedPmids.push(...articles.map((a) => a.pmid));
      result.added += articles.length;
    }

    // A paper already stored under another disease may also match this one —
    // link it here too, without a wasteful refetch. A newly created link counts
    // toward `added`: from this feed's view the paper just appeared, even though
    // it wasn't fetched from PubMed. Without this the banner shows "Added 0"
    // while the feed grew.
    const alreadyKnown = pmids.filter((p) => known.has(p));
    result.added += linkKnown(alreadyKnown, id);

    // Warm the citation cache for just-added papers (brand new, so always
    // missing) so their graph opens instantly. Best-effort: a failure must not
    // fail the poll — the graph view lazily backfills any gaps on load, and the
    // 14-day staleness refresh stays lazy there too.
    await warmCitations(savedPmids, disease.name);

    setDiseaseLastPolled(id, new Date().toISOString());
  } catch (err) {
    result.error = errMessage(err);
  }
  return result;
}

export async function pollAll(): Promise<PollResult[]> {
  const results: PollResult[] = [];
  for (const disease of listDiseases()) {
    results.push(await pollDisease(disease.id));
  }
  return results;
}

// Serialize every poll — scheduled and manual — through one flag so runs can't
// overlap and multiply NCBI traffic (PubMed rate-limits globally by API key/IP).
// node-cron fires runScheduled without awaiting the prior run, and /refresh can
// fire at any time; either way a poll started while one is in flight is refused,
// not stacked. The check-and-set is race-free on Node's single thread since no
// await sits between them.
let isPolling = false;

// Run `fn` under the poll lock. Returns null if a poll is already in progress.
export async function withPollLock<T>(fn: () => Promise<T>): Promise<T | null> {
  if (isPolling) return null;
  isPolling = true;
  try {
    return await fn();
  } finally {
    isPolling = false;
  }
}

// ---------- scheduler ----------

let task: ScheduledTask | null = null;

// Whether an expression is a schedulable cron string. Exported so the settings
// route can reject bad input up front (a 400) instead of saving it and letting
// rescheduleFromSettings silently fall back to the default below.
export function isValidCron(expr: string): boolean {
  return cron.validate(expr);
}

export function startScheduler(): void {
  rescheduleFromSettings();
}

export function rescheduleFromSettings(): void {
  const { poll_cron, poll_enabled } = getSettings();
  if (task) {
    task.stop();
    task = null;
  }
  if (poll_enabled !== "1") {
    console.log("[scheduler] scheduled polling is off");
    return;
  }
  const expr = poll_cron || DEFAULT_POLL_CRON;
  if (!cron.validate(expr)) {
    console.warn(`[scheduler] invalid cron "${expr}" — using default "${DEFAULT_POLL_CRON}"`);
    task = cron.schedule(DEFAULT_POLL_CRON, runScheduled);
    return;
  }
  task = cron.schedule(expr, runScheduled);
  console.log(`[scheduler] polling scheduled: "${expr}"`);
}

async function runScheduled(): Promise<void> {
  const results = await withPollLock(() => {
    console.log("[scheduler] running scheduled poll...");
    return pollAll();
  });
  if (results === null) {
    console.log("[scheduler] skipped: a poll is already running");
    return;
  }
  const added = results.reduce((s, r) => s + r.added, 0);
  console.log(`[scheduler] poll complete: ${added} new paper(s) across ${results.length} disease(s)`);
  for (const r of results) {
    if (r.error) console.warn(`[scheduler]   ${r.diseaseName}: ${r.error}`);
  }
}
