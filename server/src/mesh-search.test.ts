import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// The topic picker says which synonym a heading was found through.
//
// Searching "cush" offers Denture Liners, because MeSH lists "Cushion Liner" as
// one of its entry terms. Shown bare, that reads as a bug. What is asserted is
// that the synonym comes back only when it is what matched — a heading that
// matches in its own right carries none, even when its synonyms match too — and
// that it is the closest one: a prefix match before a substring, then the
// shortest. The ranking itself must come out as it did before the synonym was
// carried, so the order of the hits is pinned as well.

let db: Db;

beforeAll(async () => {
  db = await openTempDb("mesh-search");
  // As parseDescriptorRecord emits them: the heading first among its own terms.
  db.replaceMeshData(
    [
      {
        ui: "D003480",
        name: "Cushing Syndrome",
        terms: ["Cushing Syndrome", "Syndrome, Cushing", "Cushing's Syndrome"],
      },
      {
        ui: "D003772",
        name: "Denture Liners",
        terms: ["Denture Liners", "Cushion Liners", "Cushion Liner", "Liner, Cushion"],
      },
      {
        ui: "D047748",
        name: "Pituitary ACTH Hypersecretion",
        terms: [
          "Pituitary ACTH Hypersecretion",
          "Cushing's Disease",
          "Cushing Disease",
          "Disease, Cushing",
        ],
      },
      {
        ui: "D054088",
        name: "Endocardial Cushions",
        terms: ["Endocardial Cushions", "Endocardial Cushion"],
      },
      { ui: "D003920", name: "Diabetes Mellitus", terms: ["Diabetes Mellitus"] },
      { ui: "D006432", name: "Hemochromatosis", terms: ["Hemochromatosis", "Bronze Diabetes"] },
    ],
    "2026"
  );
});

afterAll(closeTempDb);

describe("searchMesh", () => {
  it("names the synonym a heading matched through, and only then", () => {
    expect(db.searchMesh("cush")).toEqual([
      { ui: "D003480", name: "Cushing Syndrome", synonym: null, rank: 0 },
      { ui: "D003772", name: "Denture Liners", synonym: "Cushion Liner", rank: 1 },
      { ui: "D047748", name: "Pituitary ACTH Hypersecretion", synonym: "Cushing Disease", rank: 1 },
      { ui: "D054088", name: "Endocardial Cushions", synonym: null, rank: 2 },
    ]);
  });

  it("names none for a heading that contains the query, even when a synonym matches closer", () => {
    // "Syndrome, Cushing" is a prefix match and the heading only a substring
    // one, so the synonym row wins the ranking — rank 1, as before — but the
    // heading is still offered in its own right.
    expect(db.searchMesh("syndrome")).toEqual([
      { ui: "D003480", name: "Cushing Syndrome", synonym: null, rank: 1 },
    ]);
    expect(db.searchMesh("liner")).toEqual([
      { ui: "D003772", name: "Denture Liners", synonym: null, rank: 1 },
    ]);
  });

  it("still ranks a heading match above a synonym-only one", () => {
    expect(db.searchMesh("diabetes")).toEqual([
      { ui: "D003920", name: "Diabetes Mellitus", synonym: null, rank: 0 },
      { ui: "D006432", name: "Hemochromatosis", synonym: "Bronze Diabetes", rank: 3 },
    ]);
  });
});
