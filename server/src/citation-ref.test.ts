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

  it("reads a DOI out of a publisher's article URL", () => {
    expect(parseRef("https://www.nejm.org/doi/full/10.1056/NEJMoa2035389")).toMatchObject({
      kind: "doi",
      doi: "10.1056/nejmoa2035389",
    });
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

  it("reads a PMID out of a PubMed URL", () => {
    expect(parseRef("https://pubmed.ncbi.nlm.nih.gov/31234567/")).toMatchObject({
      kind: "pmid",
      pmid: "31234567",
    });
  });

  it("reads the legacy ncbi.nlm.nih.gov/pubmed URL too", () => {
    expect(parseRef("https://www.ncbi.nlm.nih.gov/pubmed/31234567").pmid).toBe("31234567");
  });

  it("finds a PubMed link at the end of a full reference", () => {
    const ref = parseRef(
      "Smith J. Effects of foo. Lancet. 2019;380:1699. https://pubmed.ncbi.nlm.nih.gov/31234567/"
    );
    expect(ref).toMatchObject({ kind: "pmid", pmid: "31234567" });
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
    expect(ref.reason).toMatch(/DOI or PubMed link/i);
  });

  it("refuses a PMID on its own, and says to paste the link", () => {
    // Only a PubMed link may carry one — see the note above parseRef.
    for (const line of ["31234567", "PMID: 31234567", "pmid 999", "2019"]) {
      const ref = parseRef(line);
      expect(ref.kind).toBe("unknown");
      expect(ref.pmid).toBeUndefined();
      expect(ref.reason).toMatch(/PubMed link/);
    }
  });

  it("refuses a labelled PMID inside a reference that has no DOI or link", () => {
    const ref = parseRef("Smith J. Effects of foo. Lancet. 2019;380:1699. PMID: 31234567");
    expect(ref.kind).toBe("unknown");
    expect(ref.reason).toMatch(/PMIDs on their own/);
  });

  it("refuses the client locator format", () => {
    expect(parseRef("[Smith 2019/p1699/col2/par1/lines 6-12]").kind).toBe("unknown");
  });

  it("refuses an in-text citation", () => {
    expect(parseRef("(Smith et al., 2019)").kind).toBe("unknown");
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
