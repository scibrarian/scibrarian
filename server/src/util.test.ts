import { describe, it, expect } from "vitest";
import {
  chunk,
  errMessage,
  GENERIC_SERVER_ERROR,
  httpError,
  round1,
  safeError,
  safeMessage,
} from "./util.js";

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

describe("safeMessage", () => {
  it("passes through a message we authored", () => {
    expect(safeMessage(safeError("Couldn't reach PubMed."))).toBe("Couldn't reach PubMed.");
    expect(safeMessage(httpError(503, "Try again in a minute."))).toBe("Try again in a minute.");
  });

  it("hides internal detail from unmarked errors", () => {
    // The shapes that actually reach the client-facing layers: an fs error
    // naming a blob path, a library string, a bare throwable.
    const enoent = new Error("ENOENT: no such file or directory, open '/srv/data/blobs/9f2c'");
    expect(safeMessage(enoent)).toBe(GENERIC_SERVER_ERROR);
    expect(safeMessage(new Error("SQLITE_CONSTRAINT: UNIQUE failed"))).toBe(GENERIC_SERVER_ERROR);
    expect(safeMessage("raw string")).toBe(GENERIC_SERVER_ERROR);
    expect(safeMessage(null)).toBe(GENERIC_SERVER_ERROR);
  });

  it("does not treat a forged expose property as a marker", () => {
    // `expose` must be our own flag, not something an upstream payload can set
    // to a truthy non-true value and slip past the check.
    expect(safeMessage(Object.assign(new Error("leak"), { expose: "true" }))).toBe(
      GENERIC_SERVER_ERROR
    );
    expect(safeMessage(Object.assign(new Error("leak"), { expose: 1 }))).toBe(
      GENERIC_SERVER_ERROR
    );
  });

  it("keeps httpError compatible with the error middleware's checks", () => {
    const err = httpError(503, "Upstream is down.");
    expect(err.status).toBe(503);
    expect(err.expose).toBe(true);
    expect(err).toBeInstanceOf(Error);
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
