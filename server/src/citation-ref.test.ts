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

  it("prefers the DOI when a reference carries an author and year too", () => {
    // A full Vancouver reference has all three. The DOI identifies the paper
    // exactly; the author/year pair only narrows it.
    const ref = parseRef("Smith J, Jones AB. Effects of foo. N Engl J Med. 2019;380:1699. doi:10.1056/NEJMoa1");
    expect(ref.kind).toBe("doi");
    expect(ref.author).toBeUndefined();
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
    // Without a label there is nothing to say which number this is, and 2019 in
    // a citation string is a year.
    expect(parseRef("we enrolled 31234567 patients").kind).not.toBe("pmid");
  });
});

describe("parseRef — citation strings", () => {
  it("parses the client locator format", () => {
    expect(parseRef("[Smith 2019/p1699/col2/par1/lines 6-12]")).toMatchObject({
      kind: "citation",
      author: "Smith",
      authorKey: "smith",
      year: 2019,
    });
  });

  it("does not read the page number in a locator as the year", () => {
    // `p1699` is four digits in a plausible range; only the standalone number
    // is a year. Getting this wrong searches the wrong year and reports a held
    // paper as not held.
    expect(parseRef("[Smith 2019/p1699/col2/par1/lines 6-12]").year).toBe(2019);
    expect(parseRef("[Jones 1998/p2001/col1]").year).toBe(1998);
  });

  it("parses an in-text citation", () => {
    expect(parseRef("(Smith et al., 2019)")).toMatchObject({
      author: "Smith",
      year: 2019,
    });
  });

  it("parses a Vancouver reference with no DOI", () => {
    expect(
      parseRef("Smith J, Jones AB, Lee C. Effects of foo on bar. N Engl J Med. 2019;380(4):1699-710.")
    ).toMatchObject({ kind: "citation", author: "Smith", year: 2019 });
  });

  it("skips leading initials on a given-name-first name", () => {
    expect(parseRef("J Smith 2019").author).toBe("Smith");
  });

  it("skips 'et al' when it leads the line", () => {
    expect(parseRef("et al. Smith 2019").author).toBe("Smith");
  });

  it("keeps surname particles together but matches on the distinctive word", () => {
    // PubMed stores the whole surname in one string ("Van Der Berg J"), so the
    // last word is what a substring match should look for.
    expect(parseRef("van der Berg 2019")).toMatchObject({
      author: "van der Berg",
      authorKey: "berg",
    });
    expect(parseRef("de Silva M, et al. 2021")).toMatchObject({
      author: "de Silva",
      authorKey: "silva",
    });
  });

  it("keeps accented surnames intact", () => {
    expect(parseRef("Müller K. Some title. 2020;1:1.")).toMatchObject({
      author: "Müller",
      authorKey: "müller",
    });
  });

  it("takes the author from before the year, not from the title", () => {
    expect(parseRef("Smith J. Berg syndrome revisited. Lancet. 2019;1:1.").author).toBe("Smith");
  });
});

describe("parseRef — what it refuses to guess", () => {
  it("reports a blank line", () => {
    expect(parseRef("   ").kind).toBe("unknown");
  });

  it("reports an author with no year", () => {
    const ref = parseRef("Smith et al.");
    expect(ref.kind).toBe("unknown");
    expect(ref.reason).toMatch(/year/i);
  });

  it("reports a year with no author", () => {
    const ref = parseRef("(2019)");
    expect(ref.kind).toBe("unknown");
    expect(ref.reason).toMatch(/author/i);
  });

  it("reads a lone number as a PMID even when it looks like a year", () => {
    // Documented ambiguity: short PMIDs are real, and a bare year answers
    // nothing anyway, so the paste-a-column-of-ids case wins.
    expect(parseRef("2019")).toMatchObject({ kind: "pmid", pmid: "2019" });
  });

  it("rejects a year outside the plausible range", () => {
    expect(parseRef("Smith 1492").kind).toBe("unknown");
    expect(parseRef("Smith 2199").kind).toBe("unknown");
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
