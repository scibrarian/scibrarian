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

  // The drain makes a collision with "Sync now" routine rather than rare, and a
  // busy run reports zeros it never measured. Read as an outcome that is
  // "everything is already with your organization" while the sweep holding the
  // lock still has hundreds of papers to go.
  it("says nothing about a run that collided with another sweep", () => {
    expect(
      describeSweep({
        sent: 0,
        skipped: 0,
        remaining: 0,
        error: "A sync is already running.",
        busy: true,
      })
    ).toBe("");
  });

  // The other half of the same defect: held_back is absent on that path, not
  // zero, and a zero would have silently dropped the warning instead.
  it("does not report held-back files from a run that counted none", () => {
    expect(describeSweep({ sent: 0, skipped: 0, remaining: 0, held_back: 6 })).toBe(
      "Everything shared is already with your organization. 6 papers aren't shared — matched by hand, so they can't be verified."
    );
    expect(describeSweep({ sent: 0, skipped: 0, remaining: 0, busy: true, held_back: 6 })).toBe("");
  });

  // The count that must never be folded into "already there". That sentence
  // says the organisation holds the paper; for these nobody does, and a writer
  // who reads it stops looking for a file that never arrived.
  it("says a file could not be read rather than that it is already there", () => {
    expect(describeSweep({ sent: 2, skipped: 0, remaining: 1, unreadable: 1 })).toBe(
      "Copied 2 up, 1 still to go. 1 couldn't be sent — its stored PDF is missing."
    );
    expect(describeSweep({ sent: 0, skipped: 0, remaining: 3, unreadable: 3 })).toBe(
      "Nothing copied yet — 3 still to go. 3 couldn't be sent — their stored PDFs are missing."
    );
  });

  it("stays quiet about a run that read everything it wanted", () => {
    // 0 is a measured answer worth saying nothing about; absent is a run that
    // never counted, and must not become a claim either way.
    expect(describeSweep({ sent: 1, skipped: 0, remaining: 0, unreadable: 0 })).toBe("Copied 1 up.");
    expect(describeSweep({ sent: 1, skipped: 0, remaining: 0 })).toBe("Copied 1 up.");
    expect(describeSweep({ sent: 0, skipped: 0, remaining: 0, busy: true, unreadable: 4 })).toBe("");
  });

  it("puts the unreadable files ahead of the ones held back by design", () => {
    // Both can be true at once. The lost files come first: those are staying
    // put on purpose, these are a library that has lost PDFs.
    expect(
      describeSweep({ sent: 0, skipped: 0, remaining: 2, unreadable: 2, held_back: 1 })
    ).toBe(
      "Nothing copied yet — 2 still to go. 2 couldn't be sent — their stored PDFs are missing. " +
        "1 paper isn't shared — matched by hand, so it can't be verified."
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
