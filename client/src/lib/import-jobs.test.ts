import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImportJobs } from "./import-jobs";
import type { ImportJob } from "../types";

// The store's own bookkeeping. What a view does with what it holds is
// CollectionView.test's.

const running: ImportJob = {
  jobId: "job",
  state: "running",
  total: 2,
  processed: 0,
  matched: 0,
  unmatched: 0,
  errors: 0,
  currentFile: null,
  startedAt: "2026-10-26T00:00:00Z",
  finishedAt: null,
};
const done: ImportJob = { ...running, state: "done", processed: 2, matched: 2 };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checking a collection", () => {
  it("asks once for checks made while the first is on its way", async () => {
    const getStatus = vi.fn().mockResolvedValue({ state: "idle" });
    const jobs = createImportJobs(getStatus, () => {});
    await Promise.all([jobs.check(1), jobs.check(1)]);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(jobs.get(1)).toEqual({ state: "idle" });
  });

  it("doesn't ask about a scan it is already polling", async () => {
    const getStatus = vi.fn().mockResolvedValue(running);
    const jobs = createImportJobs(getStatus, () => {});
    await jobs.check(1);
    await jobs.check(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
    jobs.stop();
  });

  it("records nothing for a check that fails", async () => {
    const jobs = createImportJobs(() => Promise.reject(new Error("offline")), () => {});
    await jobs.check(1);
    expect(jobs.get(1)).toBeUndefined();
  });
});

describe("following a scan", () => {
  it("polls until it ends, then says so once", async () => {
    const getStatus = vi.fn().mockResolvedValue(running);
    const onSettled = vi.fn();
    const jobs = createImportJobs(getStatus, onSettled);
    jobs.follow(7, running);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onSettled).not.toHaveBeenCalled();
    getStatus.mockResolvedValue(done);
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(7);
    expect(jobs.get(7)).toBe(done);
    // Two ticks before the end, and none after it.
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  // A folder's lookup saves papers each round; the folder is refreshed as it
  // fills in, once per round that found something, not once per tick.
  it("says when a running job has matched more, and only then", async () => {
    const getStatus = vi.fn().mockResolvedValue(running);
    const onSettled = vi.fn();
    const onMatched = vi.fn();
    const jobs = createImportJobs(getStatus, onSettled, onMatched);
    jobs.follow(7, running);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onMatched).not.toHaveBeenCalled();
    getStatus.mockResolvedValue({ ...running, processed: 1, matched: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onMatched).toHaveBeenCalledTimes(1);
    expect(onMatched).toHaveBeenCalledWith(7);
    // The end is onSettled's, even when it matched more.
    getStatus.mockResolvedValue(done);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onMatched).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("stops when told to", async () => {
    const getStatus = vi.fn().mockResolvedValue(running);
    const jobs = createImportJobs(getStatus, () => {});
    jobs.follow(7, running);
    jobs.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(getStatus).not.toHaveBeenCalled();
  });
});
