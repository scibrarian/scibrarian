import { describe, it, expect } from "vitest";
import { rankCandidates, toSuggestion, topByCount } from "./journal-rank.js";
import type { CatalogRow } from "./db.js";

const row = (nlm_id: string, title: string, metric: number | null): CatalogRow => ({
  nlm_id,
  title,
  med_abbr: `${title} abbr`,
  iso_abbr: "",
  issn_print: `issn-${nlm_id}`,
  issn_online: "",
  metric,
  metric_fetched_at: null,
});

describe("topByCount", () => {
  it("ranks journal ids by frequency, id-asc on ties, and applies the limit", () => {
    const ids = ["b", "a", "c", "a", "b", "a", "d", "c"];
    expect(topByCount(ids, 3)).toEqual([
      { nlmId: "a", count: 3 },
      { nlmId: "b", count: 2 },
      { nlmId: "c", count: 2 },
    ]);
  });

  it("returns empty for an empty sample", () => {
    expect(topByCount([], 10)).toEqual([]);
  });
});

describe("rankCandidates", () => {
  it("orders by metric desc, sinking unknown metrics, with volume breaking ties", () => {
    const cands = [
      { row: row("1", "Mega Journal", 3.1), count: 90 },
      { row: row("2", "Elite Journal", 40.2), count: 12 },
      { row: row("3", "No Metric Yet", null), count: 50 },
      { row: row("4", "Solid Journal", 3.1), count: 30 },
    ];
    expect(rankCandidates(cands, 3).map((c) => c.row.nlm_id)).toEqual(["2", "1", "4"]);
  });

  it("does not mutate the input order", () => {
    const cands = [
      { row: row("1", "A", 1), count: 1 },
      { row: row("2", "B", 2), count: 1 },
    ];
    rankCandidates(cands, 2);
    expect(cands[0].row.nlm_id).toBe("1");
  });
});

describe("toSuggestion", () => {
  it("maps catalog fields the way /journals/search does (abbr and issn fallbacks)", () => {
    expect(toSuggestion({ row: row("9", "Journal Nine", 2.5), count: 1 })).toEqual({
      nlm_id: "9",
      title: "Journal Nine",
      abbr: "Journal Nine abbr",
      issn: "issn-9",
      metric: 2.5,
    });
  });
});
