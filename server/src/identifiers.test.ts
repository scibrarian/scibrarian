import { describe, expect, it } from "vitest";
import { barePmid, findDoi, labelledPmid, searchIdentifiers } from "./identifiers.js";

describe("labelledPmid", () => {
  it("reads the shapes that say 'this number is a PMID'", () => {
    expect(labelledPmid("PMID: 33301246")).toBe("33301246");
    expect(labelledPmid("pmid 33301246")).toBe("33301246");
    expect(labelledPmid("PMID.33301246")).toBe("33301246");
    expect(labelledPmid("https://pubmed.ncbi.nlm.nih.gov/33301246/")).toBe("33301246");
  });

  it("finds one inside a longer reference", () => {
    expect(labelledPmid("Smith J. Foo. Lancet. 2019;380:1699. PMID: 31234567")).toBe("31234567");
  });

  it("does not invent one from a bare number", () => {
    // That is barePmid's job, and the two callers disagree about whether to do
    // it — so this function must not decide for them.
    expect(labelledPmid("33301246")).toBeNull();
  });
});

describe("barePmid", () => {
  it("accepts a line that is nothing but a number", () => {
    expect(barePmid("33301246")).toBe("33301246");
    expect(barePmid("  33301246  ")).toBe("33301246");
    // Older papers really do have short ids.
    expect(barePmid("1975")).toBe("1975");
  });

  it("rejects a number with anything else on the line", () => {
    expect(barePmid("33301246 Smith")).toBeNull();
    expect(barePmid("vol 399:1120-31")).toBeNull();
  });
});

describe("findDoi", () => {
  it("extracts a DOI from a full reference", () => {
    expect(findDoi("Jones AB. Effects. Lancet. 2022. doi:10.1056/NEJMoa2035389")).toBe(
      "10.1056/nejmoa2035389"
    );
  });

  it("keeps Elsevier's parenthesised PII DOIs whole", () => {
    // The Phase 1 bug: truncating at `(` yields a *different* DOI, not a partial
    // one, and the same extraction governs PDF import.
    expect(findDoi("10.1016/S0140-6736(14)60001-1")).toBe("10.1016/s0140-6736(14)60001-1");
  });

  it("returns null when there is no DOI", () => {
    expect(findDoi("Smith J. Foo. Lancet. 2019;380:1699.")).toBeNull();
  });
});

describe("searchIdentifiers", () => {
  it("extracts both, with no precedence between them", () => {
    // A pasted reference carrying both should match on either, so unlike
    // parseRef this does not let the DOI win and discard the PMID.
    const { pmid, doi } = searchIdentifiers("Smith J. Foo. doi:10.1056/NEJMoa1 PMID: 31234567");
    expect(doi).toBe("10.1056/nejmoa1");
    expect(pmid).toBe("31234567");
  });

  it("takes a bare number as a PMID", () => {
    expect(searchIdentifiers("33301246").pmid).toBe("33301246");
  });

  it("does not take a bare four-digit year as a PMID", () => {
    // The one deliberate divergence from citation-ref.ts. Typing a year into a
    // search box is an ordinary query; quietly adding whichever 1970s paper
    // holds PMID 2019 is noise in a result list.
    expect(searchIdentifiers("2019").pmid).toBeNull();
    expect(searchIdentifiers("1985").pmid).toBeNull();
  });

  it("withholds only four-digit numbers inside the year range", () => {
    // The exclusion is as narrow as it can be: everything that cannot be read
    // as a year is still a PMID, including the short ids older papers carry.
    expect(searchIdentifiers("1975").pmid).toBeNull(); // in range
    expect(searchIdentifiers("1799").pmid).toBe("1799"); // four digits, below it
    expect(searchIdentifiers("2100").pmid).toBe("2100"); // four digits, above it
    expect(searchIdentifiers("12345").pmid).toBe("12345");
    expect(searchIdentifiers("999").pmid).toBe("999");
  });

  it("finds nothing in an ordinary text query", () => {
    expect(searchIdentifiers("pembrolizumab resistance")).toEqual({ pmid: null, doi: null });
  });
});
