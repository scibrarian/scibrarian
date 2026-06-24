import cron, { ScheduledTask } from "node-cron";
import {
  db,
  existingPmids,
  getDisease,
  getSettings,
  listDiseases,
  listJournals,
  saveArticles,
  setDiseaseLastPolled,
} from "./db.js";
import { buildTerm, fetchArticles, search } from "./pubmed.js";
import type { PollResult } from "./types.js";

const BATCH_SIZE = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Link existing articles to a disease without refetching them from PubMed.
const linkStmt = db.prepare(
  "INSERT OR IGNORE INTO article_diseases (pmid, disease_id) VALUES (?, ?)"
);
const linkKnown = db.transaction((pmids: string[], diseaseId: number) => {
  for (const pmid of pmids) linkStmt.run(pmid, diseaseId);
});

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

    for (const batch of chunk(newPmids, BATCH_SIZE)) {
      const articles = await fetchArticles(batch);
      saveArticles(articles, id);
      result.added += articles.length;
    }

    // A paper already stored under another disease may also match this one —
    // link it here too, without a wasteful refetch.
    const alreadyKnown = pmids.filter((p) => known.has(p));
    linkKnown(alreadyKnown, id);

    setDiseaseLastPolled(id, new Date().toISOString());
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
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
  const expr = getSettings().poll_cron || "0 6 * * *";
  if (task) {
    task.stop();
    task = null;
  }
  if (!cron.validate(expr)) {
    console.warn(`[scheduler] invalid cron "${expr}" — using daily 06:00`);
    task = cron.schedule("0 6 * * *", runScheduled);
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
