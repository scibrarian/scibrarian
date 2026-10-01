import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FTS_TOKENIZE, toFtsQuery } from "./fts-query.js";

describe("toFtsQuery", () => {
  it("prefix-matches each word so a half-typed query still hits", () => {
    expect(toFtsQuery("resist")).toBe('"resist"*');
    expect(toFtsQuery("pembrolizumab resistance")).toBe('"pembrolizumab"* AND "resistance"*');
  });

  it("keeps a quoted phrase as a phrase, and exact", () => {
    expect(toFtsQuery('"acquired resistance"')).toBe('"acquired resistance"');
    expect(toFtsQuery('"acquired resistance" melanoma')).toBe(
      '"acquired resistance" AND "melanoma"*'
    );
  });

  it("treats FTS5 operators as literal text, not syntax", () => {
    expect(toFtsQuery("cats AND dogs")).toBe('"cats"* AND "AND"* AND "dogs"*');
    expect(toFtsQuery("title:foo")).toBe('"title"* AND "foo"*');
    expect(toFtsQuery("a NEAR b")).toBe('"a"* AND "NEAR"* AND "b"*');
    expect(toFtsQuery("^anchored")).toBe('"anchored"*');
  });

  it("survives punctuation that would otherwise be a syntax error", () => {
    expect(toFtsQuery("100%")).toBe('"100"*');
    expect(toFtsQuery("COVID-19")).toBe('"COVID"* AND "19"*');
    expect(toFtsQuery("(unbalanced")).toBe('"unbalanced"*');
    expect(toFtsQuery('trailing"')).toBe('"trailing"*');
    expect(toFtsQuery('"unclosed phrase')).toBe('"unclosed"* AND "phrase"*');
  });

  it("keeps non-ASCII words whole", () => {
    expect(toFtsQuery("Müller")).toBe('"Müller"*');
    expect(toFtsQuery("β-catenin")).toBe('"β"* AND "catenin"*');
  });

  it("returns null when there is nothing to search for", () => {
    expect(toFtsQuery("")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
    expect(toFtsQuery("!!! ---")).toBeNull();
    expect(toFtsQuery('""')).toBeNull();
  });
});

// The sanitizer's whole job is to never produce a string FTS5 rejects, so the
// contract is checked against a real FTS5 table rather than asserted in prose.
describe("toFtsQuery output is always executable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(text, tokenize='${FTS_TOKENIZE}')`);
  db.prepare("INSERT INTO t(text) VALUES (?)").run(
    "Tumors developing pembrolizumab resistance showed loss of B2M in 100% of cases (COVID-19 era)."
  );

  const run = (q: string) => {
    const match = toFtsQuery(q);
    if (match === null) return null;
    return db.prepare("SELECT rowid FROM t WHERE t MATCH ?").all(match).length;
  };

  const hostile = [
    'cats AND dogs', 'NOT x', 'a OR b', 'NEAR(a b)', '"', '""""', '((()))', '*', '^^^',
    'title:foo', 'a:b:c', "it's", "100%", "COVID-19", "β-catenin", "-", "   ", "",
  ];
  for (const q of hostile) {
    it(`does not throw on ${JSON.stringify(q)}`, () => {
      expect(() => run(q)).not.toThrow();
    });
  }

  it("still finds the document through the sanitizer", () => {
    expect(run("pembrolizumab")).toBe(1);
    expect(run("resist")).toBe(1); // prefix
    expect(run('"developing pembrolizumab"')).toBe(1); // phrase
    expect(run("100%")).toBe(1);
    expect(run("pembrolizumab nonexistentword")).toBe(0); // AND, not OR
  });
});

// Every prefix rather than a sample, because the failures were scattered through
// the middle of words: FTS5 tokenizes a query like the text, prefixes included,
// and under porter "hepatocy" stemmed to `hepatoci*` while "resistan" overshot
// `resist`. Each word is its own row so one can't be found in another's place.
describe("toFtsQuery finds a word from every prefix of it", () => {
  const words = ["hepatocytes", "resistance", "phosphorylation", "developing"];
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(text, tokenize='${FTS_TOKENIZE}')`);
  const insert = db.prepare("INSERT INTO t(text) VALUES (?)");
  for (const word of words) insert.run(word);
  const find = db.prepare("SELECT text FROM t WHERE t MATCH ?");

  it("while the word is still being typed", () => {
    const missed = words.flatMap((word) =>
      Array.from({ length: word.length }, (_, i) => word.slice(0, i + 1)).filter(
        (prefix) =>
          !(find.all(toFtsQuery(prefix)!) as { text: string }[]).some((r) => r.text === word)
      )
    );
    expect(missed).toEqual([]);
  });
});
