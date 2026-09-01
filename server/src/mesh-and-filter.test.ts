import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// The subject filter's combining rule, against a real SQLite file.
//
// Selecting two subjects keeps the papers filed under BOTH. That is the
// opposite of the usual facet convention, and the opposite of what this filter
// did before, so it is worth pinning: the OR version and the AND version agree
// on every single-subject selection and differ only once a second box is
// ticked, which means a regression here passes any test that ticks one.
//
// A DB test rather than a unit test for the same reason as the others: the rule
// lives in a GROUP BY ... HAVING against a bind-order contract, and getting it
// wrong returns the wrong papers rather than throwing.

let db: Db;
let topic: number;

const GERD = { ui: "D005764", name: "Gastroesophageal Reflux" };
const BARRETT = { ui: "D001471", name: "Barrett Esophagus" };
const PPI = { ui: "D064804", name: "Proton Pump Inhibitors" };
// Filed on one paper and sharing it with nothing, so it is the subject that can
// only ever be a dead end alongside another.
const MANOMETRY = { ui: "D008349", name: "Manometry" };

// major flags differ per paper so "main subject only" can be told apart from
// plain filing: BOTH_MAJOR carries both stars, MIXED_MAJOR only one.
const BOTH_MAJOR = {
  pmid: "10000001",
  title: "Reflux progressing to Barrett esophagus",
  mesh: [
    { ...GERD, major: true },
    { ...BARRETT, major: true },
  ],
};
const MIXED_MAJOR = {
  pmid: "10000002",
  title: "PPI therapy in reflux disease",
  mesh: [
    { ...GERD, major: true },
    { ...PPI, major: false },
  ],
};
const NO_GERD = {
  pmid: "10000003",
  title: "Acid suppression in Barrett surveillance",
  mesh: [
    { ...BARRETT, major: false },
    { ...PPI, major: true },
  ],
};
const GERD_ONLY = {
  pmid: "10000004",
  title: "Reflux symptom burden",
  mesh: [{ ...GERD, major: false }],
};
const OFF_ON_ITS_OWN = {
  pmid: "10000005",
  title: "High-resolution manometry protocol",
  mesh: [{ ...MANOMETRY, major: true }],
};

function article(p: {
  pmid: string;
  title: string;
  mesh: { ui: string; name: string; major: boolean }[];
}) {
  return {
    pmid: p.pmid,
    title: p.title,
    abstract: "",
    journal_name: "Gut",
    mesh: { status: "MEDLINE", headings: p.mesh },
    nlm_id: null,
    authors: ["Smith J"],
    pub_date: "2021-01-01",
    pub_date_display: "2021",
    doi: `10.1000/${p.pmid}`,
    url: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
  };
}

beforeAll(async () => {
  db = await openTempDb("mesh-and-filter");
  topic = db.createTopic("Reflux", "reflux").id;
  db.saveArticles(
    [BOTH_MAJOR, MIXED_MAJOR, NO_GERD, GERD_ONLY, OFF_ON_ITS_OWN].map(article),
    topic
  );
});

afterAll(closeTempDb);

const source = () => ({ topic });
const matching = (mesh: string[], meshMajor = false) =>
  db
    .listPapers(source(), { mesh, meshMajor })
    .map((p) => p.pmid)
    .sort();
const facets = () => db.meshFacetsForSource(source());

describe("selecting subjects", () => {
  it("is unchanged for a single subject", () => {
    // The half both rules agree on. Here so a failure below can be read as the
    // combining rule rather than as the fixture or the join.
    expect(matching([GERD.ui])).toEqual(
      [BOTH_MAJOR.pmid, MIXED_MAJOR.pmid, GERD_ONLY.pmid].sort()
    );
    expect(matching([BARRETT.ui])).toEqual([BOTH_MAJOR.pmid, NO_GERD.pmid].sort());
  });

  it("keeps only the papers filed under every one of them", () => {
    // Under the old OR rule this returned four papers — everything above except
    // OFF_ON_ITS_OWN — which is the regression this file exists to catch.
    expect(matching([GERD.ui, BARRETT.ui])).toEqual([BOTH_MAJOR.pmid]);
    expect(matching([GERD.ui, PPI.ui])).toEqual([MIXED_MAJOR.pmid]);
    expect(matching([BARRETT.ui, PPI.ui])).toEqual([NO_GERD.pmid]);
  });

  it("narrows further with each subject added, down to nothing", () => {
    // No paper carries all three. An empty result is a legitimate answer for an
    // AND filter, so it must come back empty rather than fall back to any of
    // them — the failure mode that would make the filter look like it works
    // while quietly widening.
    expect(matching([GERD.ui, BARRETT.ui, PPI.ui])).toEqual([]);
    expect(matching([GERD.ui, MANOMETRY.ui])).toEqual([]);
  });

  it("reads the same in either order, and ignores a repeated id", () => {
    // The count in the HAVING is the number of *distinct* ids asked for. A
    // hand-written ?mesh=D005764,D005764 that skipped the dedupe would want two
    // rows from a paper that can only ever have one, and match nothing.
    expect(matching([BARRETT.ui, GERD.ui])).toEqual(matching([GERD.ui, BARRETT.ui]));
    expect(matching([GERD.ui, GERD.ui])).toEqual(matching([GERD.ui]));
  });

  it("requires every subject to be a main one under 'main subject only'", () => {
    // Both starred on BOTH_MAJOR, so it survives.
    expect(matching([GERD.ui, BARRETT.ui], true)).toEqual([BOTH_MAJOR.pmid]);
    // MIXED_MAJOR is starred for GERD but not for PPI. Applying the star to
    // only one of the selected subjects would keep it.
    expect(matching([GERD.ui, PPI.ui], true)).toEqual([]);
    expect(matching([GERD.ui], true)).toEqual([BOTH_MAJOR.pmid, MIXED_MAJOR.pmid].sort());
  });
});

describe("the facet counts", () => {
  it("count the whole source", () => {
    const byUi = new Map(facets().map((f) => [f.ui, f.count]));
    expect(byUi.get(GERD.ui)).toBe(3);
    expect(byUi.get(BARRETT.ui)).toBe(2);
    expect(byUi.get(PPI.ui)).toBe(2);
    expect(byUi.get(MANOMETRY.ui)).toBe(1);
  });

  it("are not narrowed by the selection, and so can over-promise", () => {
    // The trade-off the AND filter is taken on, pinned so that nobody closes
    // the gap by accident. These counts are also the sort key, so conditioning
    // them on the selection would re-rank the dropdown under the cursor on
    // every tick — including the row just clicked, which under AND holds the
    // largest count of all. A count that reads high was judged the cheaper
    // wrong (see meshFacetsForSource).
    const byUi = new Map(facets().map((f) => [f.ui, f.count]));

    // Barrett Esophagus reads 2 whether or not PPI is already picked, though
    // picking both leaves 1.
    expect(byUi.get(BARRETT.ui)).toBe(2);
    expect(matching([PPI.ui, BARRETT.ui]).length).toBe(1);

    // And a row can lead nowhere at all: Manometry reads 1 and takes a GERD
    // selection to zero, because the paper carrying it carries nothing else.
    expect(byUi.get(MANOMETRY.ui)).toBe(1);
    expect(matching([GERD.ui, MANOMETRY.ui])).toEqual([]);
  });

  it("offer every subject in the source, including one that leads nowhere", () => {
    // The other half of the same choice: the list is the source's subjects, not
    // the reachable ones, so it neither shrinks nor reorders as boxes are
    // ticked. Manometry stays on offer even once GERD is selected.
    expect(facets().map((f) => f.ui)).toContain(MANOMETRY.ui);
    expect(facets().map((f) => f.ui)).toEqual([
      GERD.ui,
      BARRETT.ui,
      PPI.ui,
      MANOMETRY.ui,
    ]);
  });
});
