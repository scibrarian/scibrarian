import { describe, it, expect } from "vitest";
import { parseRef, splitRefs } from "./citation-ref.js";

describe("parseRef — identifiers", () => {
  it("reads a bare DOI", () => {
    expect(parseRef("10.1056/NEJMoa1234567")).toMatchObject({
      kind: "doi",
      doi: "10.1056/nejmoa1234567",
    });
  });

  it("reads a DOI out of a URL or a labelled prefix", () => {
    expect(parseRef("https://doi.org/10.1038/s41586-021-03819-2").doi).toBe(
      "10.1038/s41586-021-03819-2"
    );
    expect(parseRef("doi: 10.1000/xyz123").doi).toBe("10.1000/xyz123");
  });

  it("keeps a parenthesised Elsevier DOI whole", () => {
    // The Lancet's house style. Truncating at the "(" produced a shorter DOI
    // that OpenAlex still resolved — to a completely different paper.
    expect(
      parseRef("Smith J. Title. Lancet. 2014;383:1699. doi:10.1016/S0140-6736(14)60001-1").doi
    ).toBe("10.1016/s0140-6736(14)60001-1");
  });

  it("trims sentence punctuation off a DOI ending a reference", () => {
    expect(parseRef("Smith J. Title. J Foo. 2019;1:2. doi:10.1000/abc.").doi).toBe(
      "10.1000/abc"
    );
  });

  it("finds the DOI buried in a full Vancouver reference", () => {
    // The common paste: a whole reference, answered on the one part of it that
    // identifies the paper exactly.
    const ref = parseRef("Smith J, Jones AB. Effects of foo. N Engl J Med. 2019;380:1699. doi:10.1056/NEJMoa1");
    expect(ref.kind).toBe("doi");
    expect(ref.doi).toBe("10.1056/nejmoa1");
  });

  it("reads a labelled PMID", () => {
    expect(parseRef("PMID: 31234567")).toMatchObject({ kind: "pmid", pmid: "31234567" });
    expect(parseRef("pmid 999").pmid).toBe("999");
  });

  it("reads a PMID out of a PubMed URL", () => {
    expect(parseRef("https://pubmed.ncbi.nlm.nih.gov/31234567/").pmid).toBe("31234567");
  });

  it("treats a line that is only a number as a PMID", () => {
    // Pasting a column of ids out of a spreadsheet.
    expect(parseRef("31234567")).toMatchObject({ kind: "pmid", pmid: "31234567" });
  });

  it("does not treat a number inside prose as a PMID", () => {
    // Without a label there is nothing to say which number this is.
    expect(parseRef("we enrolled 31234567 patients").kind).toBe("unknown");
  });
});

// An author and year used to be read off these and matched against held papers.
// That match couldn't uphold the one guarantee the feature makes — see the note
// at the top of citation-ref.ts. They are now reported unreadable, which says
// what the reader has to do: go and fetch the identifier.
describe("parseRef — what it refuses to guess", () => {
  it("reports a blank line", () => {
    expect(parseRef("   ").kind).toBe("unknown");
  });

  it("refuses a reference carrying no identifier", () => {
    const ref = parseRef(
      "Smith J, Jones AB, Lee C. Effects of foo on bar. N Engl J Med. 2019;380(4):1699-710."
    );
    expect(ref.kind).toBe("unknown");
    expect(ref.reason).toMatch(/PMID or DOI/i);
  });

  it("refuses the client locator format", () => {
    expect(parseRef("[Smith 2019/p1699/col2/par1/lines 6-12]").kind).toBe("unknown");
  });

  it("refuses an in-text citation", () => {
    expect(parseRef("(Smith et al., 2019)").kind).toBe("unknown");
  });

  it("reads a lone number as a PMID even when it looks like a year", () => {
    // Documented ambiguity: short PMIDs are real, so the paste-a-column-of-ids
    // case wins. Search makes the opposite call, and says why.
    expect(parseRef("2019")).toMatchObject({ kind: "pmid", pmid: "2019" });
  });

  it("always echoes the input back", () => {
    expect(parseRef("  garbage  ").input).toBe("garbage");
  });
});

describe("splitRefs", () => {
  it("splits on newlines and drops blank lines", () => {
    expect(splitRefs("10.1000/a\n\n  PMID: 12\r\n[Smith 2019]\n")).toEqual([
      "10.1000/a",
      "PMID: 12",
      "[Smith 2019]",
    ]);
  });

  it("returns nothing for an empty paste", () => {
    expect(splitRefs("\n \n")).toEqual([]);
  });
});
