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

  // Arriving at a collection whose scan ended while nobody was looking: what it
  // changed was refreshed when it ended, and is no reason to refresh again.
  it("doesn't count a scan it finds already over as one that ended", async () => {
    const onSettled = vi.fn();
    const jobs = createImportJobs(vi.fn().mockResolvedValue(done), onSettled);
    await jobs.check(1);
    expect(jobs.get(1)).toBe(done);
    expect(jobs.endings(1)).toBe(0);
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe("following a scan", () => {
  it("polls until it ends, then says so once", async () => {
    const getStatus = vi.fn().mockResolvedValue(running);
    const onSettled = vi.fn();
    const jobs = createImportJobs(getStatus, onSettled);
    jobs.start(7, running);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onSettled).not.toHaveBeenCalled();
    getStatus.mockResolvedValue(done);
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(7);
    expect(jobs.get(7)).toBe(done);
    expect(jobs.endings(7)).toBe(1);
    // Two ticks before the end, and none after it.
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  // A start answered with a job that was over already: nothing would ever poll
  // it, so this is where it ends.
  it("settles a start that is over already, once, without asking about it", async () => {
    const getStatus = vi.fn();
    const onSettled = vi.fn();
    const jobs = createImportJobs(getStatus, onSettled);
    jobs.start(7, done);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(7);
    expect(jobs.get(7)).toBe(done);
    expect(jobs.endings(7)).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("counts losing contact as an end, but doesn't settle it", async () => {
    const onSettled = vi.fn();
    const jobs = createImportJobs(() => Promise.reject(new Error("offline")), onSettled);
    jobs.start(7, running);

    await vi.advanceTimersByTimeAsync(4000);
    expect(jobs.endings(7)).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(jobs.get(7)).toEqual({ state: "lost" });
    expect(jobs.endings(7)).toBe(1);
    expect(onSettled).not.toHaveBeenCalled();
  });

  // A folder's lookup saves papers each round; the folder is refreshed as it
  // fills in, once per round that found something, not once per tick.
  it("says when a running job has matched more, and only then", async () => {
    const getStatus = vi.fn().mockResolvedValue(running);
    const onSettled = vi.fn();
    const onMatched = vi.fn();
    const jobs = createImportJobs(getStatus, onSettled, onMatched);
    jobs.start(7, running);

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
    jobs.start(7, running);
    jobs.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(getStatus).not.toHaveBeenCalled();
  });
});
