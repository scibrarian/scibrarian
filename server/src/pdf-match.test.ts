import { describe, it, expect } from "vitest";
import { findPmid, findDois } from "./pdf-match.js";

describe("findPmid", () => {
  it("finds a labeled PMID", () => {
    expect(findPmid("Front matter. PMID: 12345678. More text")).toBe("12345678");
  });

  it("accepts period or no separator and any case", () => {
    expect(findPmid("PMID. 999")).toBe("999");
    expect(findPmid("pmid 4567")).toBe("4567");
  });

  it("returns null when no PMID label is present", () => {
    expect(findPmid("A bare number 12345678 is not enough")).toBeNull();
  });

  it("rejects numbers longer than 8 digits", () => {
    expect(findPmid("PMID: 123456789")).toBeNull();
  });
});

describe("findDois", () => {
  it("finds a DOI and trims trailing sentence punctuation", () => {
    expect(findDois("doi:10.1038/s41586-021-03819-2. Next sentence")).toEqual([
      "10.1038/s41586-021-03819-2",
    ]);
  });

  it("stops the suffix at brackets and quotes", () => {
    expect(findDois("[10.1000/xyz] and \"10.1000/abc\"")).toEqual([
      "10.1000/xyz",
      "10.1000/abc",
    ]);
  });

  it("dedupes case-insensitively and lowercases the result", () => {
    expect(findDois("10.1000/ABC then again 10.1000/abc")).toEqual(["10.1000/abc"]);
  });

  it("keeps order of first appearance and caps at max", () => {
    const text = "10.1000/a 10.1000/b 10.1000/c 10.1000/d";
    expect(findDois(text)).toEqual(["10.1000/a", "10.1000/b", "10.1000/c"]);
    expect(findDois(text, 2)).toEqual(["10.1000/a", "10.1000/b"]);
  });

  it("requires a 4+ digit registrant prefix", () => {
    expect(findDois("see 10.99/x for details")).toEqual([]);
  });

  it("returns an empty array when there are no DOIs", () => {
    expect(findDois("no identifiers here")).toEqual([]);
  });
});
