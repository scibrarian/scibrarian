import { describe, it, expect } from "vitest";
import {
  buildTerm,
  esearchError,
  evidenceClass,
  MESH_STATUS_UNAVAILABLE,
  meshOutlook,
  ncbiErrorFromBody,
  parseJournalIds,
  parsePubDate,
  parseSummaries,
  parseArticleSet,
} from "./pubmed-parse.js";

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

// Captured verbatim from esearch.fcgi with retstart=9999. Note the *raw*
// newline inside the JSON string literal: this body is not valid JSON, which is
// why JSON.parse reported "Bad control character in string literal ... position
// 104" instead of anything about PubMed. Kept as a fixture so a future refactor
// can't quietly go back to guessing at column numbers.
const RETSTART_ERROR_BODY =
  '{"header":{"type":"esearch","version":"0.3"},"esearchresult":{"ERROR":"Search Backend failed: Exception:\n' +
  "'retstart' cannot be larger than 9998. For PubMed, ESearch can only retrieve the first 9,999 records " +
  'matching the query."}}';

describe("ncbiErrorFromBody", () => {
  it("recovers the message from a body JSON.parse can't read", () => {
    expect(() => JSON.parse(RETSTART_ERROR_BODY)).toThrow(); // the fixture really is malformed
    expect(ncbiErrorFromBody(RETSTART_ERROR_BODY)).toBe(
      "Search Backend failed: Exception: 'retstart' cannot be larger than 9998. For PubMed, " +
        "ESearch can only retrieve the first 9,999 records matching the query."
    );
  });

  it("collapses the newlines and indentation of an interpolated stack trace", () => {
    expect(ncbiErrorFromBody('{"ERROR":"one\n   two\n\tthree"}')).toBe("one two three");
  });

  it("truncates a very long message rather than filling a banner with it", () => {
    const long = ncbiErrorFromBody(`{"ERROR":"${"x".repeat(500)}"}`);
    expect(long).toHaveLength(300);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("returns null when the body carries no ERROR field", () => {
    expect(ncbiErrorFromBody('{"esearchresult":{"idlist":["1"]}}')).toBeNull();
    expect(ncbiErrorFromBody("<html>503</html>")).toBeNull();
  });
});

describe("esearchError", () => {
  it("finds an ERROR in a body that parsed cleanly", () => {
    // The silent variant: valid JSON, no idlist, and left unchecked it reads
    // exactly like "nothing matched".
    expect(esearchError({ esearchresult: { ERROR: "Invalid term" } })).toBe("Invalid term");
  });

  it("returns null for a normal result set", () => {
    expect(esearchError({ esearchresult: { idlist: ["1"], count: "1" } })).toBeNull();
  });

  it("ignores an empty or non-string ERROR", () => {
    expect(esearchError({ esearchresult: { ERROR: "   " } })).toBeNull();
    expect(esearchError({ esearchresult: { ERROR: 0 } })).toBeNull();
    expect(esearchError({})).toBeNull();
    expect(esearchError(null)).toBeNull();
  });
});

describe("parsePublicationTypes", () => {
  const parse = (inner: string) =>
    parseArticleSet(
      "<PubmedArticleSet><PubmedArticle><MedlineCitation Status=\"MEDLINE\"><PMID>1</PMID>" +
        `<Article><PublicationTypeList>${inner}</PublicationTypeList></Article>` +
        "</MedlineCitation></PubmedArticle></PubmedArticleSet>"
    ).get("1")!.pubTypes;

  const t = (ui: string, name: string) => `<PublicationType UI="${ui}">${name}</PublicationType>`;

  it("reads the list", () => {
    expect(parse(t("D016428", "Journal Article") + t("D016449", "Randomized Controlled Trial"))).toEqual([
      "Randomized Controlled Trial",
    ]);
  });

  it("drops 'Journal Article', which every record carries", () => {
    expect(parse(t("D016428", "Journal Article"))).toEqual([]);
  });

  it("drops funding attributions, which say who paid rather than what was done", () => {
    // Without this a paper tagged only with funding looks typed but carries no
    // evidence signal at all.
    expect(
      parse(
        t("D016428", "Journal Article") +
          t("D013485", "Research Support, N.I.H., Extramural") +
          t("D013486", "Research Support, Non-U.S. Gov't")
      )
    ).toEqual([]);
  });

  it("de-duplicates a repeated type", () => {
    expect(parse(t("D016454", "Review") + t("D016454", "Review"))).toEqual(["Review"]);
  });

  it("is empty when the record has no PublicationTypeList", () => {
    expect(
      parseArticleSet(
        "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID>" +
          "<Article><ArticleTitle>T</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>"
      ).get("1")!.pubTypes
    ).toEqual([]);
  });
});

describe("evidenceClass", () => {
  it("calls a design tag primary", () => {
    expect(evidenceClass(["Randomized Controlled Trial"], true)).toBe("primary");
    expect(evidenceClass(["Observational Study"], true)).toBe("primary");
    expect(evidenceClass(["Case Reports"], true)).toBe("primary");
  });

  it("calls a review or a meta-analysis secondary", () => {
    expect(evidenceClass(["Review"], true)).toBe("secondary");
    expect(evidenceClass(["Meta-Analysis", "Systematic Review"], true)).toBe("secondary");
  });

  it("counts editorials, comments and guidelines as secondary", () => {
    // Not "secondary literature" in the strict sense, but the question is
    // whether a numeric claim can rest on it, and it can't.
    for (const t of ["Editorial", "Comment", "Letter", "Practice Guideline"]) {
      expect(evidenceClass([t], true)).toBe("secondary");
    }
  });

  it("calls a meta-analysis of RCTs secondary, not primary", () => {
    // The case that matters most: NLM tags these with BOTH, and reading the
    // design tag first would present a pooled estimate as original data — the
    // exact mistake that puts an untraceable number in a deliverable.
    expect(
      evidenceClass(["Meta-Analysis", "Systematic Review", "Randomized Controlled Trial"], true)
    ).toBe("secondary");
  });

  it("does not call a trial protocol primary", () => {
    // A protocol reports no results, so it cannot support a numeric claim.
    expect(evidenceClass(["Clinical Trial Protocol"], true)).toBe("untyped");
  });

  it("separates 'NLM tagged nothing' from 'we never looked'", () => {
    // ~50% of real records carry no design tag at all, and that bucket is
    // mostly — not certainly — primary. Claiming otherwise would be wrong for a
    // meaningful slice of any library.
    expect(evidenceClass([], true)).toBe("untyped");
    expect(evidenceClass([], false)).toBe("unknown");
  });

  it("treats a type it doesn't recognise as no signal", () => {
    expect(evidenceClass(["Some Type NLM Added In 2030"], true)).toBe("untyped");
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

describe("parseJournalIds", () => {
  // Journal-count sample: two NEJM papers, one Lancet paper, an error stub,
  // and a doc without an nlmuniqueid.
  const body = {
    result: {
      uids: ["1", "2", "3", "4", "5"],
      "1": { uid: "1", nlmuniqueid: "0255562" },
      "2": { uid: "2", nlmuniqueid: "2985213R" },
      "3": { uid: "3", nlmuniqueid: "0255562" },
      "4": { uid: "4", error: "cannot get document summary" },
      "5": { uid: "5", title: "No journal id on this one" },
    },
  };

  it("returns one id per doc with repeats intact, skipping stubs and id-less docs", () => {
    expect(parseJournalIds(body)).toEqual(["0255562", "2985213R", "0255562"]);
  });

  it("returns empty for bodies without a result or uids", () => {
    expect(parseJournalIds({})).toEqual([]);
    expect(parseJournalIds(null)).toEqual([]);
    expect(parseJournalIds({ result: {} })).toEqual([]);
  });
});

// A trimmed-down efetch.fcgi rettype=abstract body: a structured abstract with
// section labels and an XML entity, an abstract-less second article, and a
// non-MEDLINE third that will never carry MeSH headings.
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
      <MeshHeadingList>
        <MeshHeading>
          <DescriptorName UI="D006801" MajorTopicYN="N">Humans</DescriptorName>
        </MeshHeading>
        <MeshHeading>
          <DescriptorName UI="D003924" MajorTopicYN="N">Diabetes Mellitus, Type 2</DescriptorName>
          <QualifierName UI="Q000150" MajorTopicYN="N">complications</QualifierName>
          <QualifierName UI="Q000188" MajorTopicYN="Y">drug therapy</QualifierName>
        </MeshHeading>
        <MeshHeading>
          <DescriptorName UI="D000067298" MajorTopicYN="Y">Glucagon-Like Peptides</DescriptorName>
          <QualifierName UI="Q000627" MajorTopicYN="N">therapeutic use</QualifierName>
        </MeshHeading>
      </MeshHeadingList>
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
      <MeshHeadingList>
        <MeshHeading>
          <DescriptorName UI="D009369" MajorTopicYN="Y">Neoplasms</DescriptorName>
        </MeshHeading>
      </MeshHeadingList>
    </MedlineCitation>
  </PubmedArticle>
  <PubmedArticle>
    <MedlineCitation Status="PubMed-not-MEDLINE" Owner="NLM">
      <PMID Version="1">41000005</PMID>
      <Article PubModel="Electronic">
        <ArticleTitle>A case report in a journal NLM does not index.</ArticleTitle>
      </Article>
      <MedlineJournalInfo>
        <MedlineTA>Cureus</MedlineTA>
        <NlmUniqueID>101596737</NlmUniqueID>
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

  // Numeric character references are pervasive in PubMed abstracts ("p&#60;0.05",
  // "10&#xB1;2"). They decode only because the parser sets htmlEntities; without
  // it the raw escapes reach the DB and the abstract LIKE search, and no other
  // fixture here would notice (&amp; decodes either way).
  it("decodes decimal and hex numeric character references", () => {
    const set = parseArticleSet(
      "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>41000004</PMID>" +
        "<Article><Abstract><AbstractText>TNF-&#945; fell (p&#60;0.05), dose 10&#xB1;2, n&#8805;5&#x2265;3.</AbstractText></Abstract></Article>" +
        "</MedlineCitation></PubmedArticle></PubmedArticleSet>"
    );
    expect(set.get("41000004")!.abstract).toBe("TNF-α fell (p<0.05), dose 10±2, n≥5≥3.");
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
      mesh: [],
      status: "",
      pubTypes: [],
    });
  });

  it("returns an empty map for empty or unexpected bodies", () => {
    expect(parseArticleSet("").size).toBe(0);
    expect(parseArticleSet("<html>Bad Gateway</html>").size).toBe(0);
  });
});

// The whole of Phase 2's filing rests on these two fields being where we think
// they are in the efetch response we already make, so they're pinned to a
// fixture rather than trusted.
describe("parseArticleSet — MeSH filing", () => {
  const out = parseArticleSet(articleSetXml);

  it("extracts every descriptor with its UI and heading", () => {
    expect(out.get("41000001")!.mesh.map((m) => m.name)).toEqual([
      "Humans",
      "Diabetes Mellitus, Type 2",
      "Glucagon-Like Peptides",
    ]);
    expect(out.get("41000001")!.mesh.map((m) => m.ui)).toEqual([
      "D006801",
      "D003924",
      "D000067298",
    ]);
  });

  it("marks a heading major when the descriptor is starred", () => {
    const glp1 = out.get("41000001")!.mesh.find((m) => m.ui === "D000067298")!;
    expect(glp1.major).toBe(true);
  });

  // The trap: PubMed writes the star on the qualifier for a large share of the
  // headings a paper is most about, and [majr] counts those as major too.
  it("marks a heading major when only one of its qualifiers is starred", () => {
    const t2d = out.get("41000001")!.mesh.find((m) => m.ui === "D003924")!;
    expect(t2d.major).toBe(true);
  });

  it("leaves an unstarred heading minor", () => {
    const humans = out.get("41000001")!.mesh.find((m) => m.ui === "D006801")!;
    expect(humans.major).toBe(false);
  });

  it("handles a lone MeshHeading and a lone QualifierName (no arrays)", () => {
    expect(out.get("41000002")!.mesh).toEqual([
      { ui: "D009369", name: "Neoplasms", major: true },
    ]);
  });

  it("collapses a repeated descriptor to one heading, keeping the star", () => {
    const set = parseArticleSet(
      "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>41000006</PMID><MeshHeadingList>" +
        '<MeshHeading><DescriptorName UI="D009369" MajorTopicYN="N">Neoplasms</DescriptorName></MeshHeading>' +
        '<MeshHeading><DescriptorName UI="D009369" MajorTopicYN="Y">Neoplasms</DescriptorName></MeshHeading>' +
        "</MeshHeadingList></MedlineCitation></PubmedArticle></PubmedArticleSet>"
    );
    expect(set.get("41000006")!.mesh).toEqual([
      { ui: "D009369", name: "Neoplasms", major: true },
    ]);
  });

  it("reads MedlineCitation/@Status, which says whether headings are still coming", () => {
    expect(out.get("41000001")!.status).toBe("MEDLINE");
    expect(out.get("41000005")!.status).toBe("PubMed-not-MEDLINE");
  });

  // A non-MEDLINE record has no MeshHeadingList at all — indistinguishable from
  // "not fetched yet" without the status above.
  it("returns no headings for a record PubMed will never index", () => {
    expect(out.get("41000005")!.mesh).toEqual([]);
  });
});

describe("meshOutlook", () => {
  it("treats finished indexing as settled", () => {
    expect(meshOutlook("MEDLINE")).toBe("indexed");
    expect(meshOutlook("OLDMEDLINE")).toBe("indexed");
  });

  it("separates 'never will have headings' from 'not yet'", () => {
    expect(meshOutlook("PubMed-not-MEDLINE")).toBe("none");
    expect(meshOutlook("In-Process")).toBe("pending");
    expect(meshOutlook("Publisher")).toBe("pending");
  });

  // "Indexed" is about the record being finished, not about it carrying
  // headings: a MEDLINE record NLM filed under nothing is settled with none,
  // which is a different fact from PubMed-not-MEDLINE above and is reported
  // separately (see MeshFiling). Conflating them told the reader that a paper
  // NLM had indexed was not indexed for MEDLINE.
  it("does not confuse 'indexed' with 'has headings'", () => {
    expect(meshOutlook("Completed")).toBe("indexed");
    expect(meshOutlook("MEDLINE")).not.toBe("none");
  });

  // Our own marker for a record efetch didn't return. It sits outside
  // MESH_SETTLED_STATUSES on purpose, so it reads as "ask again later" rather
  // than being written off — a missing record is as likely to be a transient
  // upstream gap as a permanent one.
  it("treats the unavailable sentinel as still in flight", () => {
    expect(meshOutlook(MESH_STATUS_UNAVAILABLE)).toBe("pending");
  });

  it("reports an unfetched record as unknown, not as having none", () => {
    expect(meshOutlook("")).toBe("unknown");
  });

  // A status NLM adds later must not be mistaken for a settled one, or those
  // records would never be looked at again.
  it("treats an unfamiliar status as still in flight", () => {
    expect(meshOutlook("Some-Future-Status")).toBe("pending");
  });
});
