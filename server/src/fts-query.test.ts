import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { toFtsQuery } from "./fts-query.js";

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
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(text, tokenize='porter unicode61')`);
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
