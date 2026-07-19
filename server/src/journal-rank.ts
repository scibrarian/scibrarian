import type { CatalogRow } from "./db.js";

// Pure ranking/merging half of the "Auto" journal suggestions (orchestration
// and fetching live in journal-suggest.ts); kept free of runtime db/network
// imports so it's testable in isolation, like pubmed-parse.ts.

export interface JournalSuggestion {
  nlm_id: string;
  title: string;
  abbr: string;
  issn: string;
  metric: number | null; // OpenAlex 2-yr mean citedness, unrounded
  topics: string[]; // topic names that produced the suggestion
}

export interface Candidate {
  row: CatalogRow;
  count: number; // articles in the topic's sample
}

const score = (m: number | null) => (m == null ? -1 : m);

// Journal frequency in a PMID sample → nlm_ids by count desc; the id-asc
// tie-break keeps the cut deterministic.
export function topByCount(nlmIds: string[], limit: number): { nlmId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const id of nlmIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts]
    .map(([nlmId, count]) => ({ nlmId, count }))
    .sort((a, b) => b.count - a.count || a.nlmId.localeCompare(b.nlmId))
    .slice(0, limit);
}

// Impact ranking of a topic's candidate pool: metric desc with unknown metrics
// sinking (mirrors /journals/search), sample volume breaking ties. Without this
// cut, raw volume would put mega-journals on top of every topic.
export function rankCandidates(cands: Candidate[], limit: number): Candidate[] {
  return [...cands]
    .sort(
      (a, b) =>
        score(b.row.metric) - score(a.row.metric) ||
        b.count - a.count ||
        a.row.title.localeCompare(b.row.title)
    )
    .slice(0, limit);
}

// Union the per-topic picks, accumulating which topics wanted each journal.
// Journals wanted by more topics sort first — they're the strongest candidates
// — then by impact.
export function mergeTopicPicks(
  perTopic: { topic: string; picks: Candidate[] }[]
): JournalSuggestion[] {
  const merged = new Map<string, JournalSuggestion>();
  for (const { topic, picks } of perTopic) {
    for (const { row } of picks) {
      const existing = merged.get(row.nlm_id);
      if (existing) existing.topics.push(topic);
      else
        merged.set(row.nlm_id, {
          nlm_id: row.nlm_id,
          title: row.title,
          abbr: row.med_abbr || row.iso_abbr,
          issn: row.issn_print || row.issn_online,
          metric: row.metric,
          topics: [topic],
        });
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      b.topics.length - a.topics.length ||
      score(b.metric) - score(a.metric) ||
      a.title.localeCompare(b.title)
  );
}
