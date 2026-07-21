import { findCatalogByNlmId, listJournals } from "./db.js";
import type { Topic } from "./types.js";
import { attachMetrics } from "./journal-catalog.js";
import {
  mergeTopicPicks,
  rankCandidates,
  topByCount,
  type Candidate,
  type JournalSuggestion,
} from "./journal-rank.js";
import { fetchJournalIds, searchRecent } from "./pubmed.js";
import { chunk, errMessage, httpError } from "./util.js";

// "Auto" journal suggestions: for each topic, sample its most recent PubMed
// papers, rank the journals that published them by volume, keep the
// highest-impact of those, and union the per-topic picks (ranking/merging is
// the pure journal-rank.ts). The suggestion query uses [majr] (MeSH *major*
// topic) — tighter than the [MeSH] term polls use — so a broad topic suggests
// the venues centrally about it, not every journal that ever tags it.

const WINDOW_YEARS = 5; // rank where the field publishes now, not historically
const SAMPLE = 300; // recent papers per topic; enough to separate the top venues
const SUMMARY_BATCH = 100; // matches the poller's esummary batch size
const CANDIDATE_POOL = 30; // volume-ranked pool that the impact ranking then cuts

export interface SuggestResult {
  results: JournalSuggestion[];
  failed: string[]; // topics whose PubMed lookup failed (partial results still count)
}

function windowStart(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - WINDOW_YEARS);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}/${mm}/${dd}`;
}

export async function suggestJournals(
  topics: Topic[],
  perTopic: number
): Promise<SuggestResult> {
  const mindate = windowStart();
  // Already-added journals are dropped before the per-topic cut, so each topic
  // still contributes up to `perTopic` *new* journals.
  const have = new Set(
    listJournals()
      .map((j) => j.nlm_id)
      .filter((id): id is string => !!id)
  );
  const perTopicPicks: { topic: string; picks: Candidate[] }[] = [];
  const failed: string[] = [];
  for (const t of topics) {
    try {
      const term = `"${t.name.replace(/"/g, "")}"[majr]`;
      const pmids = await searchRecent(term, SAMPLE, mindate);
      const ids: string[] = [];
      for (const batch of chunk(pmids, SUMMARY_BATCH)) {
        ids.push(...(await fetchJournalIds(batch)));
      }
      const cands: Candidate[] = [];
      for (const { nlmId, count } of topByCount(ids, CANDIDATE_POOL)) {
        if (have.has(nlmId)) continue;
        const row = findCatalogByNlmId(nlmId);
        if (row) cands.push({ row, count });
      }
      // Pool ≤ CANDIDATE_POOL rows, within attachMetrics's 50-ISSN per-call cap.
      await attachMetrics(cands.map((c) => c.row));
      perTopicPicks.push({ topic: t.name, picks: rankCandidates(cands, perTopic) });
    } catch (err) {
      // One topic failing (throttle exhaustion, transient NCBI error) shouldn't
      // sink the rest; the caller reports which topics were skipped.
      failed.push(t.name);
      console.warn(`[suggest] topic "${t.name}" failed:`, errMessage(err));
    }
  }
  if (topics.length > 0 && failed.length === topics.length) {
    throw httpError(503, "Couldn't reach PubMed for journal suggestions. Try again in a minute.");
  }
  return { results: mergeTopicPicks(perTopicPicks), failed };
}
