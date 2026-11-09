import { describe, expect, it } from "vitest";
import { parseReferenceFile } from "./reference-file.js";

// Reading reference-manager exports into the entries a folder import looks up.
// The records below are shaped after what EndNote, Zotero and PubMed write.

const ris = (...records: string[]) => records.join("\n");

const ENDNOTE = `TY  - JOUR
AU  - Polack, Fernando P.
AU  - Thomas, Stephen J.
AU  - Kitchin, Nicholas
AU  - Absalon, Judith
TI  - Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine
T2  - New England Journal of Medicine
PY  - 2020
DO  - 10.1056/NEJMoa2034577
AN  - 33301246
DB  - PubMed
ER  - `;

const ZOTERO = `TY  - JOUR
TI  - A title long enough that the exporter
  wrapped it onto a second line
AU  - Doe, Jane
T2  - The Lancet
DA  - 2021/03/04/
PY  - 2021
UR  - https://doi.org/10.1016/S0140-6736(21)00234-8
N1  - PMID: 33545096
ER  -`;

describe("RIS", () => {
  it("reads an EndNote record: title, authors, journal, year, DOI and PMID", () => {
    const file = parseReferenceFile(ENDNOTE)!;
    expect(file.format).toBe("ris");
    expect(file.entries).toEqual([
      {
        title: "Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine",
        authors: "Polack, Fernando P.; Thomas, Stephen J.; Kitchin, Nicholas et al.",
        journal: "New England Journal of Medicine",
        year: "2020",
        doi: "10.1056/nejmoa2034577",
        pmid: "33301246",
        article: true,
      },
    ]);
  });

  it("reads a Zotero record: wrapped lines, a DOI link and a labelled PMID in the notes", () => {
    const [entry] = parseReferenceFile(ZOTERO)!.entries;
    expect(entry.title).toBe("A title long enough that the exporter wrapped it onto a second line");
    expect(entry.year).toBe("2021");
    expect(entry.doi).toBe("10.1016/s0140-6736(21)00234-8");
    expect(entry.pmid).toBe("33545096");
  });

  it("reads every record in the file, through Windows line endings and a byte-order mark", () => {
    const text = "﻿" + ris(ENDNOTE, "", ZOTERO).replace(/\n/g, "\r\n");
    expect(parseReferenceFile(text)!.entries.map((e) => e.pmid)).toEqual(["33301246", "33545096"]);
  });

  it("takes an accession number as a PMID only when the record says it is PubMed's", () => {
    const record = (db: string) => `TY  - JOUR\nTI  - A paper\nAN  - 33301246\n${db}ER  - `;
    const pmid = (text: string) => parseReferenceFile(text)!.entries[0].pmid;
    expect(pmid(record("DB  - PubMed\n"))).toBe("33301246");
    expect(pmid(record("DP  - NLM\n"))).toBe("33301246");
    expect(pmid(record("DB  - MEDLINE\n"))).toBe("33301246");
    // Any other database's number would name a different paper that exists.
    expect(pmid(record("DB  - Web of Science\n"))).toBeNull();
    expect(pmid(record(""))).toBeNull();
  });

  it("doesn't read a PMID out of an abstract or a title", () => {
    const text =
      `TY  - JOUR\nTI  - Follow-up to PMID: 11111111\nST  - Follow-up to PMID: 11111111\n` +
      `AB  - As reported (PMID: 22222222).\nER  - `;
    expect(parseReferenceFile(text)!.entries[0].pmid).toBeNull();
  });

  // A record imported from PubMed carries its comments and corrections as
  // notes, each naming the other paper by PMID.
  const COMMENT = "N1  - Comment in: N Engl J Med. 2021;384:1576. PMID: 33596348\n";

  it("takes the record's own accession number over a PMID its notes mention", () => {
    const text = `TY  - JOUR\nTI  - A trial\n${COMMENT}AN  - 33301246\nDB  - PubMed\nER  - `;
    expect(parseReferenceFile(text)!.entries[0].pmid).toBe("33301246");
  });

  it("reads a PMID from a note only when the note opens with it", () => {
    const pmid = (note: string) => parseReferenceFile(`TY  - JOUR\nTI  - A trial\n${note}ER  - `)!.entries[0].pmid;
    expect(pmid(COMMENT)).toBeNull();
    expect(pmid("N1  - PMID: 33301246\n")).toBe("33301246");
    // Zotero writes its notes as HTML.
    expect(pmid("N1  - <div><p>PMID: 33301246</p></div>\n")).toBe("33301246");
  });

  // From Zotero's RIS test files, which carry the cases its users have hit.
  it("reads a title with a Unicode line separator in it, and the type before it", () => {
    const [entry] = parseReferenceFile(
      "TY  - BOOK\nT1  - From Basic to Applied Research:\u2028Potential Contributions\nPY  - 2014\nER  - "
    )!.entries;
    expect(entry).toMatchObject({
      title: "From Basic to Applied Research: Potential Contributions",
      year: "2014",
      article: false,
    });
  });

  it("dates a record by DA over the deprecated Y1", () => {
    const text = "TY  - JOUR\nT1  - Deprecated tag test\nY1  - 1900/01/01\nDA  - 1950/01/01\nER  - ";
    expect(parseReferenceFile(text)!.entries[0].year).toBe("1950");
  });

  it("drops the inline markup a title carries, and keeps a bare angle bracket", () => {
    const title = (ti: string) => parseReferenceFile(`TY  - JOUR\nTI  - ${ti}\nER  - `)!.entries[0].title;
    expect(title("Maintenance of <i>Schistosoma mansoni</i> in the CO<sub>2</sub> era")).toBe(
      "Maintenance of Schistosoma mansoni in the CO2 era"
    );
    expect(title("Survival when p < 0.05 and n > 10")).toBe("Survival when p < 0.05 and n > 10");
  });

  it("takes the year from the first date that has one", () => {
    const [entry] = parseReferenceFile(`TY  - JOUR\nTI  - Forthcoming\nPY  - In press\nDA  - 2024/02/01\nER  - `)!
      .entries;
    expect(entry.year).toBe("2024");
  });

  it("marks books, chapters, reports and web pages as not articles, and keeps the rest", () => {
    const typed = (ty: string) => `TY  - ${ty}\nTI  - Something\nER  - `;
    const article = (ty: string) => parseReferenceFile(typed(ty))!.entries[0].article;
    for (const ty of ["BOOK", "CHAP", "RPRT", "THES", "ELEC", "WEB", "NEWS", "SER"]) expect(article(ty)).toBe(false);
    // Generic and conference records may well be journal literature.
    for (const ty of ["JOUR", "EJOUR", "ABST", "INPR", "GEN", "CONF", "CPAPER", "XYZ"]) {
      expect(article(ty)).toBe(true);
    }
  });

  it("reads a record with nothing to look it up by, for the unmatched list", () => {
    const [entry] = parseReferenceFile(`TY  - JOUR\nTI  - An old paper\nPY  - 1987///\nER  - `)!.entries;
    expect(entry).toMatchObject({ title: "An old paper", year: "1987", doi: null, pmid: null });
  });
});

describe("MEDLINE (PubMed's .nbib)", () => {
  const NBIB = `PMID- 33301246
OWN - NLM
STAT- MEDLINE
DP  - 2020 Dec 31
TI  - Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine.
LID - 10.1056/NEJMoa2034577 [doi]
AB  - BACKGROUND: Severe acute respiratory syndrome coronavirus 2 (SARS-CoV-2)
      infection and the resulting coronavirus disease 2019 (Covid-19) have afflicted
FAU - Polack, Fernando P
AU  - Polack FP
AU  - Thomas SJ
TA  - N Engl J Med
JT  - The New England journal of medicine

PMID- 33545096
DP  - 2021 Feb
TI  - A title long enough that PubMed wraps it
      onto a second line.
AU  - Doe J
JT  - Lancet (London, England)
LID - S0140-6736(21)00234-8 [pii]
`;

  it("reads each record's PMID, DOI and what the unmatched list would show", () => {
    const file = parseReferenceFile(NBIB)!;
    expect(file.format).toBe("medline");
    expect(file.entries).toEqual([
      {
        title: "Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine.",
        authors: "Polack FP; Thomas SJ",
        journal: "The New England journal of medicine",
        year: "2020",
        doi: "10.1056/nejmoa2034577",
        pmid: "33301246",
        article: true,
      },
      {
        title: "A title long enough that PubMed wraps it onto a second line.",
        authors: "Doe J",
        journal: "Lancet (London, England)",
        year: "2021",
        // A PII is not a DOI.
        doi: null,
        pmid: "33545096",
        article: true,
      },
    ]);
  });

  // MEDLINE_PMID_RE starts a record on "PMID-33301246"; the line has to be
  // read too, or the record starts and its PMID is lost.
  it("reads tags written without the space after the hyphen", () => {
    const [entry] = parseReferenceFile("PMID-33301246\nTI  -A trial\nDP  -2020 Dec 31\n")!.entries;
    expect(entry).toMatchObject({ pmid: "33301246", title: "A trial", year: "2020" });
  });
});

describe("a file that is neither", () => {
  it("is not read", () => {
    expect(parseReferenceFile("@article{key, title={BibTeX, for later}}")).toBeNull();
    expect(parseReferenceFile("Smith J. A paper. Lancet. 2020;1:2.")).toBeNull();
    expect(parseReferenceFile("")).toBeNull();
  });
});
