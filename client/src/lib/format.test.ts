import { describe, it, expect } from "vitest";
import { formatAuthors, errorMessage, round1, titleCaseJournal } from "./format";

describe("formatAuthors", () => {
  it("shows a dash for no authors", () => {
    expect(formatAuthors([], 3)).toBe("—");
  });

  it("joins the full list when at or under the max", () => {
    expect(formatAuthors(["Smith J"], 3)).toBe("Smith J");
    expect(formatAuthors(["Smith J", "Lee K", "Patel R"], 3)).toBe("Smith J, Lee K, Patel R");
  });

  it("truncates with et al. past the max", () => {
    expect(formatAuthors(["Smith J", "Lee K", "Patel R", "Chen W"], 3)).toBe(
      "Smith J, Lee K, Patel R, et al."
    );
  });
});

describe("errorMessage", () => {
  it("extracts the message from an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error throwables", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });
});

describe("round1", () => {
  it("rounds to one decimal", () => {
    expect(round1(3.14159)).toBe(3.1);
    expect(round1(2.25)).toBe(2.3);
    expect(round1(2)).toBe(2);
  });
});

describe("titleCaseJournal", () => {
  it("capitalizes plain sentence-case titles", () => {
    expect(titleCaseJournal("cell metabolism")).toBe("Cell Metabolism");
  });

  it("keeps small words lowercase mid-title but capitalizes them first", () => {
    expect(titleCaseJournal("the new england journal of medicine")).toBe(
      "The New England Journal of Medicine"
    );
    expect(titleCaseJournal("trends in cognitive sciences")).toBe("Trends in Cognitive Sciences");
  });

  it("leaves words that already contain a capital untouched", () => {
    expect(titleCaseJournal("JAMA")).toBe("JAMA");
    expect(titleCaseJournal("lancet HIV")).toBe("Lancet HIV");
  });

  it("passes the empty string through", () => {
    expect(titleCaseJournal("")).toBe("");
  });
});
