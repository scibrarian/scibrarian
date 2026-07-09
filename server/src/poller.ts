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
const linkStmt = db.prepare(
  "INSERT OR IGNORE INTO article_diseases (pmid, disease_id) VALUES (?, ?)"
);
const linkKnown = transaction((pmids: string[], diseaseId: number) => {
  for (const pmid of pmids) linkStmt.run(pmid, diseaseId);
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

export async function pollDisease(id: number): Promise<PollResult> {
  const disease = getDisease(id);
  if (!disease) {
    return { diseaseId: id, diseaseName: `#${id}`, found: 0, added: 0, error: "Disease not found" };
  }
  const result: PollResult = { diseaseId: id, diseaseName: disease.name, found: 0, added: 0 };
  try {
    const journals = listJournals().map((j) => j.name);
    const term = buildTerm(disease.term, journals);

    const pmids = await search(term);
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
    // link it here too, without a wasteful refetch.
    const alreadyKnown = pmids.filter((p) => known.has(p));
    linkKnown(alreadyKnown, id);

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

// ---------- scheduler ----------

let task: ScheduledTask | null = null;

export function startScheduler(): void {
  rescheduleFromSettings();
}

export function rescheduleFromSettings(): void {
  const expr = getSettings().poll_cron || DEFAULT_POLL_CRON;
  if (task) {
    task.stop();
    task = null;
  }
  if (!cron.validate(expr)) {
    console.warn(`[scheduler] invalid cron "${expr}" — using default "${DEFAULT_POLL_CRON}"`);
    task = cron.schedule(DEFAULT_POLL_CRON, runScheduled);
    return;
  }
  task = cron.schedule(expr, runScheduled);
  console.log(`[scheduler] polling scheduled: "${expr}"`);
}

async function runScheduled(): Promise<void> {
  console.log("[scheduler] running scheduled poll...");
  const results = await pollAll();
  const added = results.reduce((s, r) => s + r.added, 0);
  console.log(`[scheduler] poll complete: ${added} new paper(s) across ${results.length} disease(s)`);
  for (const r of results) {
    if (r.error) console.warn(`[scheduler]   ${r.diseaseName}: ${r.error}`);
  }
}
