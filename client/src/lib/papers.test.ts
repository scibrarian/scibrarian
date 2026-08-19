import { describe, it, expect } from "vitest";
import { narrowPapers, selectionOnScreen, type PaperNarrowing } from "./papers";
import type { Paper } from "../types";

// Only four fields matter to anything under test — pmid, journal_name,
// citation_count and pub_date. The rest are filled to satisfy the type, so a
// case reads as the one row it is actually about.
const paper = (pmid: string, over: Partial<Paper> = {}): Paper => ({
  pmid,
  title: `Paper ${pmid}`,
  journal_name: "Lancet",
  authors: [],
  pub_date: "2024-01-01",
  pub_date_display: "2024",
  doi: "",
  url: "",
  citation_count: 0,
  file_id: null,
  file_name: null,
  file_exists: false,
  collections: [],
  snippet: null,
  ...over,
});

const NOTHING: PaperNarrowing = {
  deselected: new Set(),
  minCitations: 0,
  yearFrom: null,
  yearTo: null,
};
const narrowing = (over: Partial<PaperNarrowing>): PaperNarrowing => ({ ...NOTHING, ...over });

// What the table does when the button is pressed: it sends the ticks the
// current filters still leave on screen. Stated once here because every
// assertion below is about this composition rather than either half of it.
const payload = (ticked: string[], papers: Paper[], filters: PaperNarrowing): string[] =>
  [...selectionOnScreen(new Set(ticked), narrowPapers(papers, filters))].sort();

describe("narrowPapers", () => {
  const papers = [
    paper("1", { journal_name: "Lancet", citation_count: 30, pub_date: "2024-06-01" }),
    paper("2", { journal_name: "JAMA", citation_count: 5, pub_date: "2019-02-01" }),
    paper("3", { journal_name: "BMJ", citation_count: 0, pub_date: "" }),
  ];

  it("returns everything when nothing is set", () => {
    expect(narrowPapers(papers, NOTHING)).toEqual(papers);
  });

  it("drops deselected journals", () => {
    const kept = narrowPapers(papers, narrowing({ deselected: new Set(["JAMA", "BMJ"]) }));
    expect(kept.map((p) => p.pmid)).toEqual(["1"]);
  });

  it("drops papers under the citation threshold", () => {
    const kept = narrowPapers(papers, narrowing({ minCitations: 10 }));
    expect(kept.map((p) => p.pmid)).toEqual(["1"]);
  });

  it("drops papers outside the year range, undated ones included", () => {
    const kept = narrowPapers(papers, narrowing({ yearFrom: 2020 }));
    expect(kept.map((p) => p.pmid)).toEqual(["1"]);
  });

  it("doesn't mutate the list it was given", () => {
    const before = [...papers];
    narrowPapers(papers, narrowing({ minCitations: 10 }));
    expect(papers).toEqual(before);
  });
});

describe("selectionOnScreen", () => {
  it("keeps the ticks whose rows are still there", () => {
    const on = selectionOnScreen(new Set(["1", "2"]), [paper("1"), paper("2"), paper("3")]);
    expect([...on].sort()).toEqual(["1", "2"]);
  });

  it("drops a tick whose row is gone", () => {
    const on = selectionOnScreen(new Set(["1", "2"]), [paper("1")]);
    expect([...on]).toEqual(["1"]);
  });

  it("is empty when nothing is on screen", () => {
    expect(selectionOnScreen(new Set(["1", "2"]), []).size).toBe(0);
  });

  it("doesn't mutate the selection it was given", () => {
    const selected = new Set(["1", "2"]);
    selectionOnScreen(selected, [paper("1")]);
    expect([...selected].sort()).toEqual(["1", "2"]);
  });
});

// The bug this pair was split out for: a tick is stored by pmid and outlives
// the filter it was made under, because none of these filters refetches and so
// none of them changes the key the table clears its selection on. Each case
// ticks papers under one filter and presses the button under another.
describe("a tick can never outlive the row it was made on", () => {
  const papers = [
    paper("1", { journal_name: "Lancet", citation_count: 40, pub_date: "2024-01-01" }),
    paper("2", { journal_name: "JAMA", citation_count: 12, pub_date: "2022-01-01" }),
    paper("3", { journal_name: "JAMA", citation_count: 3, pub_date: "2015-01-01" }),
    paper("4", { journal_name: "BMJ", citation_count: 0, pub_date: "2001-01-01" }),
  ];
  const all = ["1", "2", "3", "4"];

  it("deselecting a journal takes its papers out of the removal", () => {
    expect(payload(all, papers, narrowing({ deselected: new Set(["JAMA"]) }))).toEqual(["1", "4"]);
  });

  it("raising the citation threshold takes the papers under it out", () => {
    expect(payload(all, papers, narrowing({ minCitations: 10 }))).toEqual(["1", "2"]);
  });

  it("narrowing the year range takes the papers outside it out", () => {
    expect(payload(all, papers, narrowing({ yearFrom: 2020, yearTo: 2024 }))).toEqual(["1", "2"]);
  });

  it("removes nothing at all when the filters hide every ticked row", () => {
    expect(payload(all, papers, narrowing({ minCitations: 999 }))).toEqual([]);
  });

  // Narrowing must not become a synonym for clearing. The point of intersecting
  // at the moment of use, rather than emptying the set on every filter change,
  // is that nudging a slider doesn't cost the ticks that still apply.
  it("keeps the ticks the filter left alone", () => {
    expect(payload(["1", "3"], papers, narrowing({ minCitations: 10 }))).toEqual(["1"]);
  });

  // Widening is where clearing-on-change and intersecting visibly differ, and
  // where the payload still has to be exactly what the button says.
  it("acts on the whole tick set again once the filter is lifted", () => {
    expect(payload(all, papers, NOTHING)).toEqual(all);
  });
});

// The same root cause in the header tick rather than the button: the table
// draws select-all when the actionable count equals the visible row count, so
// comparing a raw selection size to it claims select-all over a set that shares
// none of its members.
describe("select-all can't be drawn over rows that aren't ticked", () => {
  // Two under the threshold and two over it, so a tick set of two can be made
  // to match the visible count while sharing none of its rows.
  const papers = [
    paper("1", { citation_count: 0 }),
    paper("2", { citation_count: 0 }),
    paper("3", { citation_count: 50 }),
    paper("4", { citation_count: 50 }),
  ];
  const OVER_THRESHOLD = narrowing({ minCitations: 10 });
  const allSelected = (ticked: string[], filters: PaperNarrowing) => {
    const visible = narrowPapers(papers, filters);
    return visible.length > 0 && selectionOnScreen(new Set(ticked), visible).size === visible.length;
  };

  it("is false when equal counts cover different papers", () => {
    // Two ticked, two visible, no overlap at all — the case a raw size
    // comparison gets exactly backwards.
    expect(allSelected(["1", "2"], OVER_THRESHOLD)).toBe(false);
  });

  it("is true when every visible row is ticked", () => {
    expect(allSelected(["3", "4"], OVER_THRESHOLD)).toBe(true);
  });

  // The other direction, and the reason this isn't just a stricter test: ticks
  // the filter has since hidden mustn't stop the header reading select-all
  // either, since every row the user can see is in fact ticked.
  it("is true when the surviving ticks cover the list, though more were made", () => {
    expect(allSelected(["1", "3", "4"], OVER_THRESHOLD)).toBe(true);
  });

  it("is false on an empty list, however much is ticked", () => {
    expect(allSelected(["1", "2"], narrowing({ minCitations: 999 }))).toBe(false);
  });
});

// The invariant itself, over every combination of the three client-side filters
// rather than the handful chosen above. The cases are what a reader checks; this
// is what says no arrangement of filters and ticks was missed.
it("never sends a pmid the filters have taken off screen", () => {
  const journals = ["Lancet", "JAMA", "BMJ"];
  const papers = Array.from({ length: 24 }, (_, i) =>
    paper(String(i), {
      journal_name: journals[i % 3],
      citation_count: (i * 7) % 20,
      // Every eighth paper is undated, which the year filter drops outright.
      pub_date: i % 8 === 0 ? "" : `${2000 + (i % 25)}-01-01`,
    })
  );
  // From nothing ticked to everything, plus a pmid this source never held.
  const tickSets = [[], papers.map((p) => p.pmid), ["0", "5", "23"], ["99"]];

  for (const deselected of [[], ["JAMA"], ["Lancet", "BMJ"], journals]) {
    for (const minCitations of [0, 5, 14, 100]) {
      for (const [yearFrom, yearTo] of [
        [null, null],
        [2010, null],
        [null, 2005],
        [2010, 2015],
        [2030, 2040],
      ] as [number | null, number | null][]) {
        const filters = { deselected: new Set(deselected), minCitations, yearFrom, yearTo };
        const onScreen = new Set(narrowPapers(papers, filters).map((p) => p.pmid));
        for (const ticked of tickSets) {
          const sent = payload(ticked, papers, filters);
          // Nothing off screen, and nothing the user didn't tick.
          for (const pmid of sent) {
            expect(onScreen.has(pmid)).toBe(true);
            expect(ticked).toContain(pmid);
          }
          // And nothing quietly dropped: what survives both is what goes.
          expect(sent).toEqual([...new Set(ticked)].filter((p) => onScreen.has(p)).sort());
        }
      }
    }
  }
});
