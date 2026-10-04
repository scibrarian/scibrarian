import { findCatalogByNlmId } from "./db.js";
import type { MeshDescriptorRef } from "./types.js";
import { attachMetrics } from "./journal-catalog.js";
import {
  rankCandidates,
  toSuggestion,
  topByCount,
  type Candidate,
  type JournalSuggestion,
} from "./journal-rank.js";
import { EUTILS_BATCH, fetchJournalIds, searchRecent, topicTerm } from "./pubmed.js";
import { chunk, errMessage, httpError } from "./util.js";

// "Auto" journal suggestions for one topic: sample the most recent PubMed
// papers its headings match, rank the journals that published them by volume,
// and keep the highest-impact of those (the ranking is the pure
// journal-rank.ts). Asked about a set of headings rather than a stored topic,
// because the dialog that offers them is also the one that creates the topic.
//
// The query uses [majr] (MeSH *major* topic) — tighter than the [MeSH] term
// polls use — so a broad topic suggests the venues centrally about it, not
// every journal that ever tags it.

const WINDOW_YEARS = 5; // rank where the field publishes now, not historically
const SAMPLE = 300; // recent papers; enough to separate the top venues
const CANDIDATE_POOL = 30; // volume-ranked pool that the impact ranking then cuts

function windowStart(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - WINDOW_YEARS);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}/${mm}/${dd}`;
}

// Journals the topic already lists are not left out here: the caller knows
// what is on the list being edited, staged changes included, and this doesn't.
export async function suggestJournals(
  headings: MeshDescriptorRef[],
  limit: number
): Promise<JournalSuggestion[]> {
  const mindate = windowStart();
  try {
    let pmids = await searchRecent(topicTerm(headings, "majr"), SAMPLE, mindate);
    // Nothing recent is *mainly* about every heading at once — common for a
    // narrow combination — so sample what the topic would actually poll.
    if (pmids.length === 0) pmids = await searchRecent(topicTerm(headings), SAMPLE, mindate);
    const ids: string[] = [];
    for (const batch of chunk(pmids, EUTILS_BATCH)) {
      ids.push(...(await fetchJournalIds(batch)));
    }
    const cands: Candidate[] = [];
    for (const { nlmId, count } of topByCount(ids, CANDIDATE_POOL)) {
      const row = findCatalogByNlmId(nlmId);
      if (row) cands.push({ row, count });
    }
    // Pool ≤ CANDIDATE_POOL rows, within attachMetrics's 50-ISSN per-call cap.
    await attachMetrics(cands.map((c) => c.row));
    return rankCandidates(cands, limit).map(toSuggestion);
  } catch (err) {
    console.warn("[suggest] journal suggestions failed:", errMessage(err));
    throw httpError(503, "Couldn't reach PubMed for journal suggestions. Try again in a minute.");
  }
}
