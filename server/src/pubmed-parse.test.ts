import { describe, it, expect } from "vitest";
import { buildTerm, parsePubDate, parseSummaries, parseArticleSet } from "./pubmed-parse.js";

describe("buildTerm", () => {
  it("returns the bare trimmed term when no journals are selected", () => {
    expect(buildTerm("  neoplasms[MeSH Terms]  ", [])).toBe("neoplasms[MeSH Terms]");
  });

  it("ANDs the term with an OR-clause of journal names, stripping quotes", () => {
    expect(buildTerm("neoplasms[MeSH Terms]", ["Lancet", 'The "BMJ"'])).toBe(
      '(neoplasms[MeSH Terms]) AND ("Lancet"[Journal] OR "The BMJ"[Journal])'
    );
  });
});

describe("parsePubDate", () => {
  it("parses month-name dates, tolerating missing parts", () => {
    expect(parsePubDate("2025 Nov 20")).toBe("2025-11-20");
    expect(parsePubDate("2025 Nov")).toBe("2025-11-01");
    expect(parsePubDate("2025")).toBe("2025-01-01");
  });

  it("parses the numeric sort form", () => {
    expect(parsePubDate("2026/12/20 00:00")).toBe("2026-12-20");
    expect(parsePubDate("2025/6")).toBe("2025-06-01");
  });

  it("falls back to the year for season dates", () => {
    expect(parsePubDate("2025 Winter")).toBe("2025-01-01");
  });

  it("returns empty when no leading year is found", () => {
    expect(parsePubDate("Nov 2025")).toBe("");
    expect(parsePubDate("")).toBe("");
    expect(parsePubDate(undefined)).toBe("");
  });
});

// A trimmed-down esummary.fcgi body: one normal doc (with a future print date),
// one print-only doc, and the error stub PubMed returns for unknown ids.
const summaryBody = {
  header: { type: "esummary", version: "0.3" },
  result: {
    uids: ["41000001", "41000002", "99999999"],
    "41000001": {
      uid: "41000001",
      title: "Semaglutide  and cardiovascular outcomes. ",
      fulljournalname: "The New England journal of medicine",
      source: "N Engl J Med",
      pubdate: "2026 Dec 20",
      epubdate: "2025 Nov 20",
      sortpubdate: "2026/12/20 00:00",
      elocationid: "doi: 10.1056/NEJMoa000001",
      authors: [
        { name: "Smith J", authtype: "Author" },
        { name: "TRIAL Investigators", authtype: "CollectiveName" },
        { name: "Lee K" },
      ],
      articleids: [
        { idtype: "pubmed", value: "41000001" },
        { idtype: "doi", value: "10.1056/NEJMoa000001" },
      ],
    },
    "41000002": {
      uid: "41000002",
      title: "Print-only paper",
      source: "Lancet",
      pubdate: "2025 Jun 15",
      epubdate: "",
      sortpubdate: "2025/06/15 00:00",
      elocationid: "10.1016/S0140-6736(25)00001-2",
      authors: [],
      articleids: [{ idtype: "pubmed", value: "41000002" }],
    },
    "99999999": { uid: "99999999", error: "cannot get document summary" },
  },
};

describe("parseSummaries", () => {
  const pmids = ["41000001", "41000002", "99999999", "41000004"];
  const out = parseSummaries(pmids, summaryBody);

  it("prefers the e-pub date over a future print-issue date", () => {
    const m = out.get("41000001")!;
    expect(m.pub_date).toBe("2025-11-20");
    expect(m.pub_date_display).toBe("2025 Nov 20");
  });

  it("falls back to the print date when there is no e-pub date", () => {
    const m = out.get("41000002")!;
    expect(m.pub_date).toBe("2025-06-15");
    expect(m.pub_date_display).toBe("2025 Jun 15");
  });

  it("normalizes the title's whitespace", () => {
    expect(out.get("41000001")!.title).toBe("Semaglutide and cardiovascular outcomes.");
  });

  it("keeps individual authors and drops collective names", () => {
    expect(out.get("41000001")!.authors).toEqual(["Smith J", "Lee K"]);
  });

  it("takes the DOI from articleids, or from elocationid as a fallback", () => {
    expect(out.get("41000001")!.doi).toBe("10.1056/NEJMoa000001");
    expect(out.get("41000002")!.doi).toBe("10.1016/S0140-6736(25)00001-2");
  });

  it("uses source when fulljournalname is missing", () => {
    expect(out.get("41000002")!.journal_name).toBe("Lancet");
  });

  it("skips error stubs and ids missing from the response", () => {
    expect(out.has("99999999")).toBe(false);
    expect(out.has("41000004")).toBe(false);
  });

  it("returns an empty map for a body with no result", () => {
    expect(parseSummaries(["1"], {}).size).toBe(0);
    expect(parseSummaries(["1"], null).size).toBe(0);
  });
});

// A trimmed-down efetch.fcgi rettype=abstract body: a structured abstract with
// section labels and an XML entity, plus an abstract-less second article.
const articleSetXml = `<?xml version="1.0" ?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation Status="MEDLINE" Owner="NLM">
      <PMID Version="1">41000001</PMID>
      <Article PubModel="Print-Electronic">
        <ArticleTitle>Semaglutide and cardiovascular outcomes.</ArticleTitle>
        <Abstract>
          <AbstractText Label="BACKGROUND" NlmCategory="BACKGROUND">Semaglutide reduces weight.</AbstractText>
          <AbstractText Label="RESULTS" NlmCategory="RESULTS">Events fell 20% &amp; effects were mild.</AbstractText>
        </Abstract>
      </Article>
      <MedlineJournalInfo>
        <Country>United States</Country>
        <MedlineTA>N Engl J Med</MedlineTA>
        <NlmUniqueID>0255562</NlmUniqueID>
        <ISSNLinking>0028-4793</ISSNLinking>
      </MedlineJournalInfo>
    </MedlineCitation>
  </PubmedArticle>
  <PubmedArticle>
    <MedlineCitation Status="MEDLINE" Owner="NLM">
      <PMID Version="1">41000002</PMID>
      <Article PubModel="Print">
        <ArticleTitle>Print-only paper</ArticleTitle>
      </Article>
      <MedlineJournalInfo>
        <MedlineTA>Lancet</MedlineTA>
        <NlmUniqueID>2985213R</NlmUniqueID>
      </MedlineJournalInfo>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`;

describe("parseArticleSet", () => {
  const out = parseArticleSet(articleSetXml);

  it("labels structured abstract sections and decodes entities", () => {
    expect(out.get("41000001")!.abstract).toBe(
      "BACKGROUND: Semaglutide reduces weight.\n\n" +
        "RESULTS: Events fell 20% & effects were mild."
    );
  });

  it("returns an empty abstract when the article has none", () => {
    expect(out.get("41000002")!.abstract).toBe("");
  });

  it("keeps NLM ids as strings, preserving leading zeros and letters", () => {
    expect(out.get("41000001")!.nlmId).toBe("0255562");
    expect(out.get("41000002")!.nlmId).toBe("2985213R");
  });

  it("extracts the MedlineTA journal abbreviation", () => {
    expect(out.get("41000001")!.medlineTa).toBe("N Engl J Med");
    expect(out.get("41000002")!.medlineTa).toBe("Lancet");
  });

  it("handles a single-article set (no array) with a plain PMID node", () => {
    const single = parseArticleSet(
      "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>41000003</PMID>" +
        "<Article><Abstract><AbstractText>Plain unstructured abstract.</AbstractText></Abstract></Article>" +
        "</MedlineCitation></PubmedArticle></PubmedArticleSet>"
    );
    expect(single.size).toBe(1);
    expect(single.get("41000003")).toEqual({
      abstract: "Plain unstructured abstract.",
      nlmId: "",
      medlineTa: "",
    });
  });

  it("returns an empty map for empty or unexpected bodies", () => {
    expect(parseArticleSet("").size).toBe(0);
    expect(parseArticleSet("<html>Bad Gateway</html>").size).toBe(0);
  });
});
