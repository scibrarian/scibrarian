import type { CatalogRow } from "./db.js";

// Pure ranking half of the "Auto" journal suggestions (orchestration and
// fetching live in journal-suggest.ts); kept free of runtime db/network
// imports so it's testable in isolation, like pubmed-parse.ts.

export interface JournalSuggestion {
  nlm_id: string;
  title: string;
  abbr: string;
  issn: string;
  metric: number | null; // OpenAlex 2-yr mean citedness, unrounded
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
//
// The cut is the topic's top `limit` whatever it already lists. The dialog
// drops the ones it has *after* this, so the set never shifts: once a topic's
// picks are added, pressing Auto again offers nothing rather than backfilling
// with the next `limit` journals down the list.
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

// A ranked candidate as the API sends it: the catalog row, in the shape the
// catalog search returns, so the dialog stages either the same way.
export function toSuggestion({ row }: Candidate): JournalSuggestion {
  return {
    nlm_id: row.nlm_id,
    title: row.title,
    abbr: row.med_abbr || row.iso_abbr,
    issn: row.issn_print || row.issn_online,
    metric: row.metric,
  };
}
