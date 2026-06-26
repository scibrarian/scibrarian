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
  upsertCitations,
} from "./db.js";
import { fetchCitations } from "./icite.js";
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

// Fetch + cache citation rows for newly added papers so the graph view doesn't
// have to fetch them on first load. Mirrors the lazy fill in the /graph route,
// but scoped to the poll's delta. Best-effort: never throws, so a slow/failing
// iCite can't fail an otherwise successful poll.
async function warmCitations(pmids: string[], diseaseName: string): Promise<void> {
  if (pmids.length === 0) return;
  try {
    const fetched = await fetchCitations(pmids);
    const rows = [...fetched].map(([pmid, info]) => ({ pmid, info }));
    // Cache a zeroed row even when iCite has nothing for a (very new) PMID, so
    // the graph view won't re-request it on every load.
    for (const pmid of pmids) {
      if (!fetched.has(pmid)) rows.push({ pmid, info: { citation_count: 0, references: [] } });
    }
    upsertCitations(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[poll] ${diseaseName}: citation warm-up failed (will backfill on graph load): ${msg}`);
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
