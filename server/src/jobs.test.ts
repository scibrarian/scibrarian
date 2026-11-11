import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anyJobRunning,
  cancelJob,
  cancelJobs,
  clearJobs,
  isJobRunning,
  jobStatus,
  startJob,
  type JobRun,
} from "./jobs.js";
import type { ImportJob } from "./types.js";
import { GENERIC_SERVER_ERROR, httpError } from "./util.js";

// The bookkeeping a collection's scan and a folder's lookup share: one job per
// id, how one ends, how one is stopped, what a reset forgets. Each kind's own
// run is tested where it lives (folder-import.test.ts, and the scan through
// collection-delete-stops-import.test.ts); here a run is a stand-in that waits
// where it is told to, so what is pinned is the job around it.

// A run that waits on a gate the test opens, checks for a cancel the way a real
// run does after every await, and says how far it got.
function gatedRun() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const seen = { reachedEnd: false, control: null as JobRun | null };
  const run = async (job: ImportJob, control: JobRun) => {
    seen.control = control;
    job.currentFile = "reading.pdf";
    await gate;
    control.check();
    job.matched++;
    seen.reachedEnd = true;
  };
  return { run, open, seen };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  clearJobs();
});

describe("a job's run", () => {
  it("answers one with nothing pending as already over, without running it", () => {
    const run = vi.fn(async () => {});
    const job = startJob("lookup", 1, 0, "[test]", run);

    expect(job.state).toBe("done");
    expect(job.finishedAt).toBe(job.startedAt);
    expect(run).not.toHaveBeenCalled();
    expect(jobStatus("lookup", 1)).toBe(job);
  });

  it("is running until its run returns, then done, and stays to be read", async () => {
    const { run, open } = gatedRun();
    const job = startJob("scan", 1, 3, "[test]", run);

    expect(job).toMatchObject({ state: "running", total: 3, finishedAt: null });
    expect(isJobRunning("scan", 1)).toBe(true);
    expect(isJobRunning("lookup", 1)).toBe(false);

    open();
    await vi.waitFor(() => expect(job.state).toBe("done"));
    expect(job).toMatchObject({ matched: 1, currentFile: null });
    expect(job.finishedAt).not.toBeNull();
    expect(jobStatus("scan", 1)).toBe(job);
  });

  it("records a failure in words the reader may see, and logs the real cause", async () => {
    const shown = startJob("lookup", 1, 1, "[test] shown", async () => {
      throw httpError(503, "Couldn’t reach PubMed.");
    });
    const hidden = startJob("lookup", 2, 1, "[test] hidden", async () => {
      throw new Error("ENOENT /blobs/ab/cdef");
    });
    await vi.waitFor(() => expect(hidden.state).toBe("error"));

    expect(shown).toMatchObject({ state: "error", error: "Couldn’t reach PubMed." });
    expect(hidden).toMatchObject({ state: "error", error: GENERIC_SERVER_ERROR });
    expect(warn).toHaveBeenCalledWith("[test] hidden: failed: ENOENT /blobs/ab/cdef");
  });

  it("ends silently when its run stops itself, and stays to be read", async () => {
    const job = startJob("lookup", 1, 1, "[test]", async (_job, control) => {
      control.stop();
    });
    await vi.waitFor(() => expect(job.state).toBe("error"));

    expect(job.error).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(jobStatus("lookup", 1)).toBe(job);
  });
});

describe("stopping a job", () => {
  it("stops the run at its next check, waits for it, and forgets the job", async () => {
    const { run, open, seen } = gatedRun();
    const job = startJob("scan", 1, 1, "[test]", run);

    let stopped = false;
    const cancelling = cancelJob("scan", 1).then(() => (stopped = true));
    // Flagged in the tick of the call, before anything was awaited.
    expect(seen.control!.cancelled).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);

    open();
    await cancelling;
    expect(seen.reachedEnd).toBe(false);
    expect(job).toMatchObject({ state: "error", matched: 0 });
    expect(job.error).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(jobStatus("scan", 1)).toBeNull();
  });

  it("leaves a newer job over the same id in place", async () => {
    const older = gatedRun();
    startJob("scan", 1, 1, "[test]", older.run);
    const cancelling = cancelJob("scan", 1);
    const newer = startJob("scan", 1, 1, "[test]", gatedRun().run);

    older.open();
    await cancelling;
    expect(jobStatus("scan", 1)).toBe(newer);
  });

  it("answers at once for an id with no job", async () => {
    await expect(cancelJob("lookup", 9)).resolves.toBeUndefined();
  });

  it("stops every run of one kind, and no other", async () => {
    const lookups = [gatedRun(), gatedRun()];
    const scan = gatedRun();
    const a = startJob("lookup", 1, 1, "[test]", lookups[0].run);
    const b = startJob("lookup", 2, 1, "[test]", lookups[1].run);
    const c = startJob("scan", 1, 1, "[test]", scan.run);

    cancelJobs("lookup");
    for (const r of [...lookups, scan]) r.open();
    await vi.waitFor(() => expect([a, b, c].every((j) => j.state !== "running")).toBe(true));

    expect([a.state, b.state, c.state]).toEqual(["error", "error", "done"]);
    expect(lookups.some((r) => r.seen.reachedEnd)).toBe(false);
    expect(scan.seen.reachedEnd).toBe(true);
  });
});

describe("asking about every job at once", () => {
  it("says whether any job of a kind, or of either kind, is running", async () => {
    expect(anyJobRunning()).toBe(false);
    const { run, open } = gatedRun();
    const job = startJob("lookup", 1, 1, "[test]", run);

    expect(anyJobRunning("lookup")).toBe(true);
    expect(anyJobRunning("scan")).toBe(false);
    expect(anyJobRunning()).toBe(true);

    open();
    await vi.waitFor(() => expect(job.state).toBe("done"));
    expect(anyJobRunning()).toBe(false);
  });

  it("forgets every finished job, of both kinds, on clear", () => {
    startJob("scan", 1, 0, "[test]", async () => {});
    startJob("lookup", 1, 0, "[test]", async () => {});

    clearJobs();
    expect(jobStatus("scan", 1)).toBeNull();
    expect(jobStatus("lookup", 1)).toBeNull();
  });
});
