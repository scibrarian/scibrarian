import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { ALL, FED, FILED, LOOSE, SAVED, article, seedHoldings } from "./unheld-sweep-fixture.js";

// Letting go of papers, through holding.ts: what each way of letting go takes
// with it, the order it does that in, when the sweep of papers nothing holds
// takes its turn, and what a reset refuses to run alongside.
//
// What the sweep takes once it runs is unheld-sweep.test.ts. What is pinned
// here is everything around it. A removal doesn't delete the paper it lets go
// of, because a paper is stored before the file or bookmark it is stored for is
// attached, and one deleted in between leaves a file matched to a paper that
// isn't there. So the sweep follows the removal, behind its reply, skips its
// turn while anything is attaching, and the next removal to find the server
// idle takes what the skipped one left.
//
// The routes that call these are unheld-sweep-routes.test.ts, one case each.
//
// The desktop build, because only the desktop has checked-out copies to leave
// behind, and every case about them would pass for a build that never had the
// problem. Set before anything reads it: config.ts reads the environment at
// import time.
process.env.SCIBRARIAN_DESKTOP = "1";

let db: Db;
let holding: typeof import("./holding.js");
let jobs: typeof import("./jobs.js");
let withPollLock: typeof import("./poller.js").withPollLock;
let blobPath: (hash: string) => string;
let checkOutForExternalOpen: (fileId: number) => Promise<string>;
let config: typeof import("./config.js");

let shelf: number;
let folder: number;

const stored = () => [...db.existingPmids(ALL)].sort();
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function gate() {
  let open!: () => void;
  const shut = new Promise<void>((resolve) => (open = resolve));
  return { shut, open };
}

// A scan or a lookup over `id`, waiting on a gate as a real one waits on
// PubMed, and checking for a cancel after it as a real one does.
function runningJob(kind: import("./jobs.js").JobKind, id: number) {
  const { shut, open } = gate();
  const seen = { wroteAfterWait: false };
  jobs.startJob(kind, id, 1, "[test]", async (_job, control) => {
    await shut;
    control.check();
    seen.wroteAfterWait = true;
  });
  const stopped = () => vi.waitFor(() => expect(jobs.isJobRunning(kind, id)).toBe(false));
  return { open, seen, stopped };
}

// A stored PDF with a copy already checked out, as if it had been opened.
async function openedPaper(collection: number, name: string, pmid?: string) {
  const bytes = Buffer.from(`%PDF-1.4\n${name}\n%%EOF\n`, "latin1");
  const hash = sha256(bytes);
  fs.writeFileSync(blobPath(hash), bytes);
  db.addCollectionFiles(collection, [{ hash, name }]);
  const row = db.listCollectionFiles(collection).find((f) => f.content_hash === hash)!;
  if (pmid) db.setFileMatched(row.id, pmid, "manual");
  const copy = await checkOutForExternalOpen(row.id);
  expect(fs.readFileSync(copy)).toEqual(bytes);
  return { fileId: row.id, hash, copy };
}

// A second removal, to give the sweep a turn. Of a paper a topic's feed goes on
// holding, so the sweep is all it changes; and of a paper, because a removal
// that takes nothing isn't given one.
function anotherRemoval(): Promise<void> {
  db.addBookmarks(folder, [FED]);
  return holding.letGoOfFolderPapers(folder, [FED]).swept;
}

beforeAll(async () => {
  db = await openTempDb("holding");
  // After openTempDb, which is what points the environment at the temp
  // directory these read at evaluation.
  ({ blobPath } = await import("./blobstore.js"));
  config = await import("./config.js");
  ({ checkOutForExternalOpen } = await import("./external-open.js"));
  ({ withPollLock } = await import("./poller.js"));
  holding = await import("./holding.js");
  jobs = await import("./jobs.js");
});

afterAll(closeTempDb);

beforeEach(() => {
  ({ shelf, folder } = seedHoldings(db));
});

afterEach(() => {
  jobs.clearJobs();
});

it("is running as the desktop build", () => {
  expect(config.IS_DESKTOP).toBe(true);
});

describe("letting go, with nothing attaching", () => {
  it("takes the papers ticked out of their last folder, and any left from before", async () => {
    const released = holding.letGoOfFolderPapers(folder, [SAVED]);
    expect(released.result).toBe(1);
    await released.swept;
    expect(stored()).toEqual([FED, FILED]);
  });

  it("takes the papers of a deleted folder", async () => {
    await holding.letGoOfFolder(folder).swept;
    expect(db.getBookmarkFolder(folder)).toBeUndefined();
    expect(stored()).toEqual([FED, FILED]);
  });

  it("takes a paper removed from its collection", async () => {
    const released = await holding.letGoOfCollectionPapers(shelf, [FILED]);
    expect(released.result).toEqual({ removed: 1, papers: 1 });
    await released.swept;
    expect(stored()).toEqual([FED, SAVED]);
  });

  it("takes the papers of a deleted collection", async () => {
    await (await holding.letGoOfCollection(shelf)).swept;
    expect(db.getCollection(shelf)).toBeUndefined();
    expect(stored()).toEqual([FED, SAVED]);
  });

  it("takes the paper of a deleted file", async () => {
    const file = db.listCollectionFiles(shelf)[0];
    await (await holding.letGoOfFile(file.id)).swept;
    expect(stored()).toEqual([FED, SAVED]);
  });

  it("gives the sweep no turn for the one-paper toggle", async () => {
    // The toggle in Interests, where a paper is in a feed and stays held.
    holding.letGoOfFolderPaper(folder, SAVED);
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.listBookmarks()).toEqual([]);
    expect(stored()).toEqual(ALL);
  });

  it("gives the sweep no turn for a removal that took nothing", async () => {
    const none = holding.letGoOfFolderPapers(folder, []);
    expect(none.result).toBe(0);
    await none.swept;
    expect(stored()).toEqual(ALL);

    const notThere = await holding.letGoOfCollectionPapers(shelf, [SAVED]);
    expect(notThere.result).toEqual({ removed: 0, papers: 0 });
    await notThere.swept;
    expect(stored()).toEqual(ALL);
  });
});

// A checked-out copy belongs to a paper: every file row holding the bytes it
// was handed. Each removal that drops file rows has to take the copies none
// names any longer, since a copy that outlives its paper is a readable PDF under
// the paper's own name that nothing will ever collect.
describe("the checked-out copies a removal takes", () => {
  it("takes the copy when one file is deleted", async () => {
    const collection = db.createCollection("One file").id;
    const { fileId, copy } = await openedPaper(collection, "Deleted on its own.pdf");

    await holding.letGoOfFile(fileId);
    expect(fs.existsSync(copy)).toBe(false);
  });

  it("keeps the copy while another collection still holds the paper", async () => {
    const opened = db.createCollection("Opened from").id;
    const { fileId, hash, copy } = await openedPaper(opened, "Shelved twice.pdf");
    const kept = db.createCollection("Still shelved").id;
    db.addCollectionFiles(kept, [{ hash, name: "Shelved twice.pdf" }]);

    await holding.letGoOfFile(fileId);
    // The copy is the paper's, not the row's. The reader may still have it
    // open, and a save into it belongs to the collection that kept the paper.
    expect(fs.existsSync(copy)).toBe(true);
  });

  it("takes the copies when papers are removed from a collection, and keeps the rest's", async () => {
    const collection = db.createCollection("Selected papers").id;
    const going = await openedPaper(collection, "Removed by pmid.pdf", "40000123");
    // A second paper in the same collection that was not asked for: the copies
    // go by orphanhood, so one whose row survives has to survive with it.
    const staying = await openedPaper(collection, "Not in the selection.pdf", "40000124");

    await holding.letGoOfCollectionPapers(collection, ["40000123"]);
    expect(fs.existsSync(going.copy)).toBe(false);
    expect(fs.existsSync(staying.copy)).toBe(true);
  });

  it("takes the copies when the whole collection goes, and no other's", async () => {
    const collection = db.createCollection("Dropped whole").id;
    const first = await openedPaper(collection, "One of two.pdf");
    const second = await openedPaper(collection, "Two of two.pdf");
    const elsewhere = await openedPaper(db.createCollection("Untouched").id, "Somewhere else.pdf");

    await holding.letGoOfCollection(collection);
    expect(fs.existsSync(first.copy)).toBe(false);
    expect(fs.existsSync(second.copy)).toBe(false);
    expect(fs.existsSync(elsewhere.copy)).toBe(true);
  });
});

describe("a manual match", () => {
  const MATCHED = "55555555";

  it("holds the paper it stores from the moment it is stored", async () => {
    db.addCollectionFiles(shelf, [{ hash: "c".repeat(64), name: "unmatched.pdf" }]);
    const file = db.listCollectionFiles(shelf).find((f) => f.file_name === "unmatched.pdf")!;

    await holding.rematchFile(file, MATCHED, [article(MATCHED)]).swept;
    await anotherRemoval();
    expect(db.existingPmids([MATCHED]).size).toBe(1);
  });

  it("gives the sweep a turn for the paper its file was matched to before", async () => {
    const file = db.listCollectionFiles(shelf)[0];
    await holding.rematchFile(file, LOOSE, [article(LOOSE)]).swept;
    expect(stored()).toEqual([FED, SAVED, LOOSE]);
  });

  it("gives it none when the file had no paper to let go of", async () => {
    db.addCollectionFiles(shelf, [{ hash: "c".repeat(64), name: "unmatched.pdf" }]);
    const file = db.listCollectionFiles(shelf).find((f) => f.file_name === "unmatched.pdf")!;
    await holding.rematchFile(file, MATCHED, [article(MATCHED)]).swept;
    expect(stored()).toEqual(ALL);
  });
});

describe("the order a removal runs in", () => {
  it("answers before a deleted collection's scan has stopped, and sweeps once it has", async () => {
    const scan = runningJob("scan", shelf);

    const released = await holding.letGoOfCollection(shelf);
    // Answered, with the scan still waiting on its PubMed request: the reply
    // isn't held up by it, and neither is anything swept yet.
    expect(jobs.isJobRunning("scan", shelf)).toBe(true);
    expect(stored()).toEqual(ALL);

    scan.open();
    await released.swept;
    // Told to stop in the tick of the delete, so it wrote nothing after it.
    expect(scan.seen.wroteAfterWait).toBe(false);
    expect(jobs.jobStatus("scan", shelf)).toBeNull();
    expect(stored()).toEqual([FED, SAVED]);
  });

  it("answers before a deleted folder's lookup has stopped, and sweeps once it has", async () => {
    const lookup = runningJob("lookup", folder);

    const released = holding.letGoOfFolder(folder);
    expect(jobs.isJobRunning("lookup", folder)).toBe(true);
    expect(stored()).toEqual(ALL);

    lookup.open();
    await released.swept;
    expect(lookup.seen.wroteAfterWait).toBe(false);
    expect(jobs.jobStatus("lookup", folder)).toBeNull();
    expect(stored()).toEqual([FED, FILED]);
  });
});

describe("a removal while something is attaching", () => {
  // Each starts something part way through storing a paper and attaching it,
  // and answers with how to let it finish.
  const attaching: [string, () => { finish: () => Promise<unknown> }][] = [
    [
      "links are being added, or an entry given its PMID",
      () => {
        const { shut, open } = gate();
        const work = holding.whileAttaching("attach", () => shut);
        return { finish: () => (open(), work) };
      },
    ],
    [
      "a copy arrives from another library",
      () => {
        const { shut, open } = gate();
        const work = holding.whileAttaching("transfer", () => shut);
        return { finish: () => (open(), work) };
      },
    ],
    [
      "a collection is being scanned",
      () => {
        const scan = runningJob("scan", db.createCollection("Scanning").id);
        return { finish: () => (scan.open(), scan.stopped()) };
      },
    ],
    [
      "a folder's entries are being looked up",
      () => {
        const lookup = runningJob("lookup", db.createBookmarkFolder("Looking up").id);
        return { finish: () => (lookup.open(), lookup.stopped()) };
      },
    ],
    [
      "a poll is running",
      () => {
        const { shut, open } = gate();
        const poll = withPollLock(() => shut);
        return { finish: () => (open(), poll) };
      },
    ],
  ];

  it.each(attaching)("leaves the papers while %s, and the next removal takes them", async (_, start) => {
    const busy = start();
    try {
      await holding.letGoOfFolderPapers(folder, [SAVED]).swept;
      // Off the folder's list, and still stored: whatever is attaching may be
      // about to attach it.
      expect(db.listBookmarks()).toEqual([]);
      expect(stored()).toEqual(ALL);
    } finally {
      // Whatever happened, or it stays out, and every sweep after it in this
      // file is skipped.
      await busy.finish();
    }

    await anotherRemoval();
    expect(stored()).toEqual([FED, FILED]);
  });

  it("gives the sweep back its turn when an attach fails", async () => {
    await expect(
      holding.whileAttaching("attach", async () => {
        throw new Error("PubMed was unreachable");
      })
    ).rejects.toThrow("unreachable");

    await holding.letGoOfFolderPapers(folder, [SAVED]).swept;
    expect(stored()).toEqual([FED, FILED]);
  });
});

describe("deleting all data", () => {
  const count = (table: string): number =>
    (db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

  it("refuses while a collection is being scanned, and deletes nothing", async () => {
    const scan = runningJob("scan", shelf);
    try {
      expect(await holding.deleteAllData()).toEqual({ refused: "scan" });
      expect(count("articles")).toBe(ALL.length);
    } finally {
      scan.open();
      await scan.stopped();
    }
  });

  it("refuses while a copy arrives from another library, and deletes nothing", async () => {
    const { shut, open } = gate();
    const transfer = holding.whileAttaching("transfer", () => shut);
    try {
      expect(await holding.deleteAllData()).toEqual({ refused: "transfer" });
      expect(count("articles")).toBe(ALL.length);
    } finally {
      open();
      await transfer;
    }
  });

  it("refuses while a refresh holds the poll lock, and deletes nothing", async () => {
    const { shut, open } = gate();
    const poll = withPollLock(() => shut);
    try {
      expect(await holding.deleteAllData()).toEqual({ refused: "refresh" });
      expect(count("articles")).toBe(ALL.length);
    } finally {
      open();
      await poll;
    }
  });

  it("goes ahead while links are being added, which find their folder gone and write nothing", async () => {
    const { shut, open } = gate();
    const links = holding.whileAttaching("attach", () => shut);
    try {
      const outcome = await holding.deleteAllData();
      expect("stats" in outcome && outcome.stats.papers).toBe(ALL.length);
      expect(count("articles")).toBe(0);
    } finally {
      open();
      await links;
    }
  });

  it("stops a folder's lookup, and forgets every job", async () => {
    const lookup = runningJob("lookup", folder);
    jobs.startJob("scan", shelf, 0, "[test]", async () => {});

    expect("stats" in (await holding.deleteAllData())).toBe(true);
    expect(jobs.jobStatus("lookup", folder)).toBeNull();
    expect(jobs.jobStatus("scan", shelf)).toBeNull();

    lookup.open();
    await lookup.stopped();
    expect(lookup.seen.wroteAfterWait).toBe(false);
  });

  it("takes the checked-out copies with it", async () => {
    // resetLibrary empties the tables and unlinks every blob, and a copy is
    // neither: it is a plaintext PDF under the paper's own name, in a directory
    // the reader can open. Someone resetting a library to get sensitive papers
    // off their disk is describing exactly the papers with a copy there.
    const { hash, copy } = await openedPaper(db.createCollection("Papers").id, "Sensitive.pdf");

    expect("stats" in (await holding.deleteAllData())).toBe(true);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(config.EXTERNAL_OPEN_DIR)).toBe(false);
    // And the blob, which resetLibrary was already doing — asserted here so a
    // reset that stopped deleting either half is one failure, not a puzzle.
    expect(fs.existsSync(blobPath(hash))).toBe(false);
  });
});
