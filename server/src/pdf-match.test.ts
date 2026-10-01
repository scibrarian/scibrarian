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

  it("keeps parentheses that belong to the DOI", () => {
    // Elsevier's PII-based DOIs — most of the Lancet — carry them. Truncating
    // at the "(" yields a different, resolvable DOI rather than nothing.
    expect(findDois("10.1016/S0140-6736(14)60001-1")).toEqual([
      "10.1016/s0140-6736(14)60001-1",
    ]);
  });

  it("drops a closing parenthesis the DOI didn't open", () => {
    expect(findDois("(see doi:10.1000/xyz)")).toEqual(["10.1000/xyz"]);
    expect(findDois("(10.1016/S0140-6736(14)60001-1).")).toEqual([
      "10.1016/s0140-6736(14)60001-1",
    ]);
  });

  it("stops the suffix at brackets and quotes", () => {
    expect(findDois("[10.1000/xyz] and \"10.1000/abc\"")).toEqual([
      "10.1000/xyz",
      "10.1000/abc",
    ]);
  });

  it("stops at a publisher URL's query or fragment", () => {
    // Each of these was read with the query or fragment attached: a DOI no one
    // registered, so the paper behind it was reported as not held.
    expect(findDois("https://www.nejm.org/doi/full/10.1056/NEJMoa2035389?query=featured_home")).toEqual([
      "10.1056/nejmoa2035389",
    ]);
    expect(findDois("https://www.nejm.org/doi/full/10.1056/NEJMoa2035389#article_references")).toEqual([
      "10.1056/nejmoa2035389",
    ]);
    expect(
      findDois("https://www.tandfonline.com/doi/full/10.1080/03007995.2020.1786330?journalCode=icmo20")
    ).toEqual(["10.1080/03007995.2020.1786330"]);
    expect(findDois("Is it 10.1000/abc?")).toEqual(["10.1000/abc"]);
  });

  it("ends a DOI given as a query parameter at the next parameter", () => {
    expect(
      findDois("https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0242958&type=printable")
    ).toEqual(["10.1371/journal.pone.0242958"]);
  });

  it("drops the page a publisher's URL names after the DOI", () => {
    expect(findDois("https://onlinelibrary.wiley.com/doi/10.1111/dom.14123/full")).toEqual([
      "10.1111/dom.14123",
    ]);
    expect(findDois("https://www.frontiersin.org/articles/10.3389/fimmu.2020.01234/pdf")).toEqual([
      "10.3389/fimmu.2020.01234",
    ]);
    expect(findDois("https://link.springer.com/content/pdf/10.1007/s00125-020-05123-x.pdf")).toEqual([
      "10.1007/s00125-020-05123-x",
    ]);
    expect(findDois("https://doi.org/10.1000/xyz/")).toEqual(["10.1000/xyz"]);
    // A page and a full stop, in either order of stripping.
    expect(findDois("Available at 10.1111/dom.14123/abstract.")).toEqual(["10.1111/dom.14123"]);
  });

  it("keeps a slash that belongs to the DOI", () => {
    // Oxford's DOIs carry one inside the suffix; only the named pages are cut.
    expect(findDois("https://academic.oup.com/doi/10.1093/eurheartj/ehaa612")).toEqual([
      "10.1093/eurheartj/ehaa612",
    ]);
    // A suffix that is nothing but one of those words is the DOI, not a page.
    expect(findDois("10.1000/full")).toEqual(["10.1000/full"]);
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
