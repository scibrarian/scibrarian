import { describe, it, expect } from "vitest";
import { chunk, errMessage, round1 } from "./util.js";

describe("chunk", () => {
  it("splits into equal chunks with a short remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("handles exact multiples", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("returns one chunk when size exceeds the array", () => {
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunk([], 3)).toEqual([]);
  });
});

describe("errMessage", () => {
  it("extracts the message from an Error", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error throwables", () => {
    expect(errMessage("plain string")).toBe("plain string");
    expect(errMessage(42)).toBe("42");
  });
});

describe("round1", () => {
  it("rounds to one decimal", () => {
    expect(round1(3.14159)).toBe(3.1);
    expect(round1(2.25)).toBe(2.3);
  });

  it("passes null through", () => {
    expect(round1(null)).toBeNull();
  });
});
