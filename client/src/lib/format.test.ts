import { describe, it, expect } from "vitest";
import { describeSweep, formatAuthors, errorMessage, round1, titleCaseJournal } from "./format";

describe("describeSweep", () => {
  it("reports a genuinely finished sweep as finished", () => {
    expect(describeSweep({ sent: 0, skipped: 0, remaining: 0 })).toBe(
      "Everything shared is already with your organization."
    );
  });

  // The finding this exists for: sent and skipped are both zero, so the old
  // test called it complete — with twelve papers still outstanding.
  it("does not call a sweep finished while work remains", () => {
    expect(describeSweep({ sent: 0, skipped: 0, remaining: 12 })).toBe(
      "Nothing copied yet — 12 still to go."
    );
  });

  it("keeps partial progress when a sweep stopped part way", () => {
    expect(describeSweep({ sent: 3, skipped: 0, remaining: 9, error: "master refused: 507" })).toBe(
      "Copied 3 up, 9 still to go."
    );
  });

  it("names each count that happened, and none that didn't", () => {
    expect(describeSweep({ sent: 3, skipped: 2, remaining: 0 })).toBe(
      "Copied 3 up, 2 already there."
    );
    expect(describeSweep({ sent: 0, skipped: 4, remaining: 0 })).toBe("4 already there.");
    expect(describeSweep({ sent: 5, skipped: 0, remaining: 0 })).toBe("Copied 5 up.");
  });
});

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
