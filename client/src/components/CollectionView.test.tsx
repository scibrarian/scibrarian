// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CollectionView } from "./CollectionView";
import { createImportJobs, type ImportJobs } from "../lib/import-jobs";
import { dataTransfer, fileEntry, folderEntry } from "../lib/test-drops";
import type { CollectionFile, ImportJob } from "../types";

// The collection shell around an import: what it says when a scan finishes,
// what becomes of a scan that ends after the view has gone, and the count of
// unmatched files at the top of the page, with the dialog it opens.
const api = vi.hoisted(() => ({
  getCollectionFiles: vi.fn(),
  getImportStatus: vi.fn(),
  uploadFiles: vi.fn(),
  startImport: vi.fn(),
  setFilePmid: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

// App's half: the scans it follows, and what it is told when one ends.
let jobs: ImportJobs;
const settled = vi.fn();

beforeEach(() => {
  api.getCollectionFiles.mockResolvedValue({ files: [] });
  api.getImportStatus.mockResolvedValue({ state: "idle" });
  jobs = createImportJobs(api.getImportStatus, settled);
});

afterEach(() => {
  cleanup();
  jobs.stop();
  vi.useRealTimers();
  vi.resetAllMocks();
});

// The poll's tick, and nothing else, so testing-library's own waits still run
// on real time.
const fakePoll = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
const tick = (ms = 1000) => act(() => vi.advanceTimersByTimeAsync(ms));

// The file listing is cached per collection at module level, and that cache is
// what the remount tests depend on, so every test takes its own collection.
let nextId = 1;

function row(id: number, collectionId: number, match_status: CollectionFile["match_status"]): CollectionFile {
  return {
    id,
    collection_id: collectionId,
    file_name: `paper-${id}.pdf`,
    pmid: match_status === "matched" ? String(30000000 + id) : null,
    match_status,
    match_method: match_status === "matched" ? "pmid" : "",
    match_error: "",
    added_at: "2026-10-26T00:00:00Z",
    exists: true,
  };
}

function job(over: Partial<ImportJob>): ImportJob {
  return {
    jobId: "job",
    state: "done",
    total: 3,
    processed: 3,
    matched: 3,
    unmatched: 0,
    errors: 0,
    currentFile: null,
    startedAt: "2026-10-26T00:00:00Z",
    finishedAt: "2026-10-26T00:00:05Z",
    ...over,
  };
}

function View({
  id,
  reloadToken = 0,
  onChanged = () => {},
  isAdmin = true,
}: {
  id: number;
  reloadToken?: number;
  onChanged?: () => void;
  isAdmin?: boolean;
}) {
  return (
    <CollectionView
      collectionId={id}
      name="Cardiology"
      isAdmin={isAdmin}
      summary="1 paper"
      stamp={null}
      reloadToken={reloadToken}
      importJobs={jobs}
      onChanged={onChanged}
      onDeleted={() => {}}
    >
      <div />
    </CollectionView>
  );
}

// Let a mocked request and the state it sets land.
const settle = () => act(async () => {});

// The count in the summary line, and the dialog it opens.
const unmatchedLink = () => screen.queryByRole("button", { name: /\d+ unmatched/ });
const unmatchedDialog = () => screen.queryByRole("dialog", { name: "Unmatched files" });
async function openFiles(link: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: link }));
  await settle();
  return unmatchedDialog()!;
}
const openUnmatched = (count: number) => openFiles(`${count} unmatched`);

describe("a scan that ends after its collection has been left", () => {
  it("is still followed, and refreshes the collection when it ends", async () => {
    fakePoll();
    const id = nextId++;
    api.getCollectionFiles.mockResolvedValue({ files: [row(1, id, "pending"), row(2, id, "pending")] });
    api.getImportStatus.mockResolvedValue(job({ state: "running", processed: 0, matched: 0 }));
    const first = render(<View id={id} />);
    await settle();
    // Over to Interests: the view goes, and the poll stays.
    first.unmount();

    api.getImportStatus.mockResolvedValue(job({ total: 2, processed: 2, matched: 1, unmatched: 1 }));
    await tick();
    expect(settled).toHaveBeenCalledWith(id);

    // What App does with that: the collection's token moves on, so coming back
    // to it fetches the list the scan left rather than painting the cached one.
    api.getCollectionFiles.mockResolvedValue({ files: [row(1, id, "matched"), row(2, id, "unmatched")] });
    render(<View id={id} reloadToken={1} />);
    const dialog = await openUnmatched(1);
    expect(api.getCollectionFiles).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByText("paper-2.pdf")).toBeTruthy();
    expect(within(dialog).queryByText("paper-1.pdf")).toBeNull();
  });

  it("leaves rows nothing ever scanned as they are, without refreshing for them", async () => {
    const id = nextId++;
    api.getCollectionFiles.mockResolvedValue({ files: [row(3, id, "pending")] });
    // The server restarted mid-job: no job, and the row is still pending.
    api.getImportStatus.mockResolvedValue({ state: "idle" });
    const onChanged = vi.fn();
    render(<View id={id} onChanged={onChanged} />);
    const dialog = await openFiles("1 not scanned");

    const group = within(dialog).getByRole("region", { name: /Not scanned/ });
    expect(within(group).getByText("paper-3.pdf")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    expect(api.getCollectionFiles).toHaveBeenCalledTimes(1);
  });
});

describe("a scan that ends while the view is open", () => {
  it("holds the pre-scan rows back until the refreshed list lands", async () => {
    fakePoll();
    const id = nextId++;
    api.getCollectionFiles.mockResolvedValue({ files: [row(1, id, "pending")] });
    api.getImportStatus.mockResolvedValue(job({ state: "running", total: 1, processed: 0, matched: 0 }));
    const { rerender } = render(<View id={id} />);
    await settle();
    expect(screen.getByText(/Scanning 0 \/ 1/)).toBeTruthy();

    api.getImportStatus.mockResolvedValue(job({ total: 1, processed: 1, matched: 0, unmatched: 1 }));
    await tick();
    expect(settled).toHaveBeenCalledWith(id);
    // Over, but the row on screen is still the pre-scan one, and not an answer.
    expect(screen.queryByText(/Scanning/)).toBeNull();
    expect(unmatchedLink()).toBeNull();

    api.getCollectionFiles.mockResolvedValue({ files: [row(1, id, "unmatched")] });
    rerender(<View id={id} reloadToken={1} />);
    const dialog = await openUnmatched(1);
    expect(within(dialog).queryByText(/never scanned/)).toBeNull();
  });

  it("says so when it loses contact with the scan", async () => {
    fakePoll();
    const id = nextId++;
    api.getImportStatus.mockResolvedValue(job({ state: "running", processed: 0, matched: 0 }));
    render(<View id={id} />);
    await settle();

    api.getImportStatus.mockRejectedValue(new Error("offline"));
    await tick(5000);
    expect(screen.getByText(/Lost contact with the import job/)).toBeTruthy();
    expect(screen.queryByText(/Scanning/)).toBeNull();
    expect(settled).not.toHaveBeenCalled();
  });
});

describe("what a finished scan says", () => {
  const pdf = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });

  // Pick files and let a scan that is over before the first poll settle.
  async function scan(files: File[], finished: ImportJob) {
    const id = nextId++;
    const added = files.filter((f) => f.name.endsWith(".pdf")).length;
    api.getImportStatus.mockResolvedValueOnce({ state: "idle" }).mockResolvedValueOnce(finished);
    api.uploadFiles.mockResolvedValue({ added, skipped: 0 });
    api.startImport.mockResolvedValue({ jobId: "job", total: added });
    const { container } = render(<View id={id} />);
    await settle();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files } });
    await waitFor(() => expect(api.getImportStatus).toHaveBeenCalledTimes(2));
    await settle();
    return container;
  }

  it("says nothing when everything matched", async () => {
    const container = await scan([pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")], job({}));
    expect(container.querySelector(".banner")).toBeNull();
  });

  it("says nothing about files it couldn't match or read, which the summary line counts", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")];
    const container = await scan(files, job({ matched: 1, unmatched: 1, errors: 1 }));
    expect(container.querySelector(".banner")).toBeNull();
  });

  it("reports a scan that failed outright", async () => {
    const failed = job({ state: "error", total: 1, processed: 0, matched: 0, error: "PubMed is down." });
    await scan([pdf("a.pdf")], failed);
    expect(screen.getByText("PubMed is down.")).toBeTruthy();
  });

  it("names what the selection left behind even when the rest all matched", async () => {
    const text = (name: string) => new File(["x"], name, { type: "text/plain" });
    const picked = [pdf("a.pdf"), pdf("b.pdf"), text("notes.txt"), text("todo.txt")];
    await scan(picked, job({ total: 2, processed: 2, matched: 2 }));
    expect(screen.getByText("Ignored 2 files that aren't PDFs.")).toBeTruthy();
  });
});

describe("files dropped onto a collection", () => {
  // The view, with uploads that take whatever is sent and a scan that is over
  // before the first poll. Returns the element drops land on.
  async function view({ isAdmin = true } = {}): Promise<HTMLElement> {
    api.getImportStatus.mockResolvedValueOnce({ state: "idle" }).mockResolvedValue(job({}));
    api.uploadFiles.mockImplementation(async (_id: number, files: File[]) => ({
      added: files.length,
      skipped: 0,
    }));
    api.startImport.mockResolvedValue({ jobId: "job", total: 1 });
    const { container } = render(<View id={nextId++} isAdmin={isAdmin} />);
    await settle();
    return container.firstElementChild as HTMLElement;
  }

  const sent = () =>
    api.uploadFiles.mock.calls.flatMap((call) => (call[1] as File[]).map((f) => f.name)).sort();
  const overlay = () => screen.queryByText("Drop PDFs or folders to add them to “Cardiology”");

  it("adds dropped PDFs at once, as picking them does", async () => {
    const target = await view();
    fireEvent.drop(target, { dataTransfer: dataTransfer([fileEntry("a.pdf"), fileEntry("b.pdf")]) });
    await waitFor(() => expect(api.startImport).toHaveBeenCalled());
    expect(sent()).toEqual(["a.pdf", "b.pdf"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before adding what a folder holds, naming the folder and the collection", async () => {
    const target = await view();
    const tree = folderEntry("Downloads", [
      fileEntry("a.pdf"),
      fileEntry("notes.txt"),
      folderEntry("2024", [fileEntry("b.pdf")]),
    ]);
    fireEvent.drop(target, { dataTransfer: dataTransfer([tree]) });
    const dialog = await screen.findByRole("dialog", {
      name: "Add 2 PDFs from “Downloads” to “Cardiology”?",
    });
    expect(api.uploadFiles).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.startImport).toHaveBeenCalled());
    expect(sent()).toEqual(["a.pdf", "b.pdf"]);
  });

  it("adds nothing when the question is turned down", async () => {
    const target = await view();
    fireEvent.drop(target, { dataTransfer: dataTransfer([folderEntry("Downloads", [fileEntry("a.pdf")])]) });
    const dialog = await screen.findByRole("dialog", { name: /^Add 1 PDF from/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await settle();
    expect(api.uploadFiles).not.toHaveBeenCalled();
  });

  it("says a dropped folder held no PDFs, without asking about it", async () => {
    const target = await view();
    fireEvent.drop(target, { dataTransfer: dataTransfer([folderEntry("Notes", [fileEntry("notes.txt")])]) });
    expect(await screen.findByText(/^No PDFs found in the selection\./)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names what a dropped folder held that couldn't be read", async () => {
    const target = await view();
    const tree = folderEntry("Downloads", [fileEntry("a.pdf"), fileEntry("locked.pdf", { unreadable: true })]);
    fireEvent.drop(target, { dataTransfer: dataTransfer([tree]) });
    const dialog = await screen.findByRole("dialog", { name: /^Add 1 PDF from/ });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Couldn't read 1 item in the dropped folders.")).toBeTruthy();
  });

  it("counts apart the PDFs dropped beside a folder, and leaves out those too big to send", async () => {
    const target = await view();
    const tree = folderEntry("Downloads", [fileEntry("b.pdf"), fileEntry("huge.pdf", { size: 200 * 1024 * 1024 })]);
    fireEvent.drop(target, { dataTransfer: dataTransfer([fileEntry("a.pdf"), tree]) });
    const dialog = await screen.findByRole("dialog", { name: "Add 1 PDF from “Downloads” to “Cardiology”?" });
    expect(within(dialog).getByText("The 1 PDF dropped with it will be added too.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.startImport).toHaveBeenCalled());
    expect(sent()).toEqual(["a.pdf", "b.pdf"]);
  });

  it("doesn't ask about a folder with nothing in it to add, and adds what was dropped beside it", async () => {
    const target = await view();
    const tree = folderEntry("Notes", [fileEntry("notes.txt")]);
    fireEvent.drop(target, { dataTransfer: dataTransfer([fileEntry("a.pdf"), tree]) });
    await waitFor(() => expect(api.startImport).toHaveBeenCalled());
    expect(sent()).toEqual(["a.pdf"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("takes nothing more while it asks about a folder, so a yes sends that folder alone", async () => {
    const target = await view();
    fireEvent.drop(target, { dataTransfer: dataTransfer([folderEntry("Downloads", [fileEntry("a.pdf")])]) });
    const dialog = await screen.findByRole("dialog", { name: /^Add 1 PDF from/ });
    // The question's backdrop covers the screen, so a second drop lands on it,
    // and React carries it up to the view the question belongs to.
    expect(fireEvent.drop(dialog, { dataTransfer: dataTransfer([fileEntry("b.pdf")]) })).toBe(true);
    await settle();
    expect(api.uploadFiles).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.startImport).toHaveBeenCalled());
    expect(sent()).toEqual(["a.pdf"]);
    expect(api.startImport).toHaveBeenCalledTimes(1);
  });

  it("doesn't show a quick walk, whose row would push the view down and back as the question opens", async () => {
    const target = await view();
    fireEvent.drop(target, { dataTransfer: dataTransfer([folderEntry("Downloads", [fileEntry("a.pdf")])]) });
    // The walk is under way, waiting on the folder's first batch.
    await settle();
    expect(screen.queryByText(/Looking for PDFs/)).toBeNull();
    await screen.findByRole("dialog", { name: /^Add 1 PDF from/ });
    expect(screen.queryByText(/Looking for PDFs/)).toBeNull();
  });

  it("counts what a folder's walk has got through, and stops it on Cancel", async () => {
    const target = await view();
    const tree = folderEntry("Home", [fileEntry("a.pdf"), folderEntry("mounted", [], { stuck: true })]);
    fireEvent.drop(target, { dataTransfer: dataTransfer([tree]) });
    expect(await screen.findByText(/Looking for PDFs in the dropped folders… 1 found in 1 folder/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Add files/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/Looking for PDFs/)).toBeNull());
    expect((screen.getByRole("button", { name: /Add files/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.uploadFiles).not.toHaveBeenCalled();
  });

  it("takes nothing dropped on a dialog the view has open", async () => {
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Delete collection" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete collection?" });
    const dt = dataTransfer([fileEntry("a.pdf")]);
    fireEvent.dragEnter(dialog, { dataTransfer: dt });
    expect(overlay()).toBeNull();
    expect(fireEvent.drop(dialog, { dataTransfer: dt })).toBe(true);
    await settle();
    expect(api.uploadFiles).not.toHaveBeenCalled();
  });

  it("takes nothing while a scan is running, whose scan would turn the new files away", async () => {
    fakePoll();
    api.getImportStatus.mockResolvedValue(job({ state: "running", processed: 1, matched: 1 }));
    const { container } = render(<View id={nextId++} />);
    await settle();
    const target = container.firstElementChild as HTMLElement;
    expect((screen.getByRole("button", { name: /Add files/ }) as HTMLButtonElement).disabled).toBe(true);
    const dt = dataTransfer([fileEntry("a.pdf")]);
    fireEvent.dragEnter(target, { dataTransfer: dt });
    expect(overlay()).toBeNull();
    expect(fireEvent.drop(target, { dataTransfer: dt })).toBe(true);
    await settle();
    expect(api.uploadFiles).not.toHaveBeenCalled();
  });

  it("shows where the drop goes for as long as files are over the view", async () => {
    const target = await view();
    const inside = target.querySelector(".source-head")!;
    const dt = dataTransfer([fileEntry("a.pdf")]);
    fireEvent.dragEnter(target, { dataTransfer: dt });
    expect(overlay()).not.toBeNull();
    // Crossing into something inside the view leaves the view's own box, and
    // isn't leaving the view.
    fireEvent.dragEnter(inside, { dataTransfer: dt });
    fireEvent.dragLeave(target, { dataTransfer: dt });
    expect(overlay()).not.toBeNull();
    fireEvent.dragLeave(inside, { dataTransfer: dt });
    expect(overlay()).toBeNull();
  });

  it("goes on showing where a drop goes for a drag already over the view when it can take one", async () => {
    const target = await view();
    const inside = target.querySelector(".source-head")!;
    let finish = () => {};
    api.uploadFiles.mockImplementationOnce(
      (_id: number, files: File[]) =>
        new Promise((resolve) => (finish = () => resolve({ added: files.length, skipped: 0 })))
    );
    fireEvent.drop(target, { dataTransfer: dataTransfer([fileEntry("a.pdf")]) });
    await screen.findByText(/^Uploading 0 \/ 1/);
    // More files dragged in while that one goes up: nothing to take them yet.
    const dt = dataTransfer([fileEntry("b.pdf")]);
    fireEvent.dragEnter(target, { dataTransfer: dt });
    expect(overlay()).toBeNull();
    finish();
    await waitFor(() => expect(overlay()).not.toBeNull());
    fireEvent.dragEnter(inside, { dataTransfer: dt });
    fireEvent.dragLeave(target, { dataTransfer: dt });
    expect(overlay()).not.toBeNull();
    fireEvent.dragLeave(inside, { dataTransfer: dt });
    expect(overlay()).toBeNull();
  });

  it("takes nothing from a viewer, and leaves the drop to be turned away", async () => {
    const target = await view({ isAdmin: false });
    const dt = dataTransfer([fileEntry("a.pdf")]);
    fireEvent.dragEnter(target, { dataTransfer: dt });
    expect(overlay()).toBeNull();
    // Not cancelled here, which is what tells refuseStrayDrops it is its to refuse.
    expect(fireEvent.drop(target, { dataTransfer: dt })).toBe(true);
    await settle();
    expect(api.uploadFiles).not.toHaveBeenCalled();
  });
});

describe("the unmatched count in the summary line", () => {
  // One paper, and two files the scan has finished with and couldn't place.
  function scanned(id: number) {
    api.getCollectionFiles.mockResolvedValue({
      files: [row(1, id, "matched"), row(2, id, "unmatched"), row(3, id, "error")],
    });
  }
  const summaryLine = (container: HTMLElement) =>
    container.querySelector(".source-summary")?.textContent;

  it("counts them, as a link that opens them", async () => {
    const id = nextId++;
    scanned(id);
    const { container } = render(<View id={id} />);

    await screen.findByRole("button", { name: "2 unmatched" });
    expect(summaryLine(container)).toBe("1 paper · 2 unmatched");
    // Nothing of them on the page until it is followed.
    expect(screen.queryByText("paper-2.pdf")).toBeNull();

    const dialog = await openUnmatched(2);
    expect(within(dialog).getByText("paper-2.pdf")).toBeTruthy();
    expect(within(dialog).getByText("paper-3.pdf")).toBeTruthy();
    // Focus goes in with it, so a keyboard user lands there too.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("counts files no scan reached apart, and lists them in a group of their own", async () => {
    const id = nextId++;
    api.getCollectionFiles.mockResolvedValue({
      files: [row(1, id, "matched"), row(2, id, "unmatched"), row(3, id, "pending"), row(4, id, "pending")],
    });
    const { container } = render(<View id={id} />);

    await screen.findByRole("button", { name: "2 not scanned" });
    expect(summaryLine(container)).toBe("1 paper · 1 unmatched · 2 not scanned");

    // Either count opens the one dialog, which keeps the two apart.
    const dialog = await openFiles("2 not scanned");
    const unscanned = within(dialog).getByRole("region", { name: /Not scanned/ });
    const unmatched = within(dialog).getByRole("region", { name: /No PubMed ID found/ });
    expect(within(unscanned).getByText("paper-3.pdf")).toBeTruthy();
    expect(within(unscanned).getByText("paper-4.pdf")).toBeTruthy();
    expect(within(unmatched).getByText("paper-2.pdf")).toBeTruthy();
    // Scanning again is for the files no scan reached, not for the rest.
    expect(within(unmatched).queryByRole("button", { name: "Scan them" })).toBeNull();
  });

  it("counts nothing while a scan is still working through the files", async () => {
    const id = nextId++;
    api.getCollectionFiles.mockResolvedValue({ files: [row(1, id, "matched"), row(2, id, "pending")] });
    api.getImportStatus.mockResolvedValue(job({ state: "running", total: 1, processed: 0, matched: 0 }));
    const { container } = render(<View id={id} />);
    await settle();

    expect(summaryLine(container)).toBe("1 paper");
  });

  it("isn't shown to a viewer, who can't match them", async () => {
    const id = nextId++;
    scanned(id);
    const { container } = render(<View id={id} isAdmin={false} />);
    await settle();

    expect(summaryLine(container)).toBe("1 paper");
  });
});

describe("the unmatched files dialog", () => {
  it("closes itself once the last file is matched, and stays closed when more turn up", async () => {
    const id = nextId++;
    api.getCollectionFiles.mockResolvedValue({ files: [row(1, id, "matched"), row(2, id, "unmatched")] });
    api.setFilePmid.mockResolvedValue({});
    const onChanged = vi.fn();
    const { rerender } = render(<View id={id} onChanged={onChanged} />);
    const dialog = await openUnmatched(1);

    fireEvent.change(within(dialog).getByPlaceholderText("PMID"), { target: { value: "30000002" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Match" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // What App does with onChanged.
    api.getCollectionFiles.mockResolvedValue({ files: [row(1, id, "matched"), row(2, id, "matched")] });
    rerender(<View id={id} reloadToken={1} onChanged={onChanged} />);
    await settle();
    expect(unmatchedDialog()).toBeNull();
    expect(unmatchedLink()).toBeNull();

    // A later upload leaves one unmatched: counted, not opened at the reader.
    api.getCollectionFiles.mockResolvedValue({
      files: [row(1, id, "matched"), row(2, id, "matched"), row(3, id, "unmatched")],
    });
    rerender(<View id={id} reloadToken={2} onChanged={onChanged} />);
    await settle();
    expect(unmatchedLink()).not.toBeNull();
    expect(unmatchedDialog()).toBeNull();
  });

  it("shows a match that failed inside itself, where the page's banner would be hidden", async () => {
    const id = nextId++;
    api.getCollectionFiles.mockResolvedValue({ files: [row(1, id, "unmatched")] });
    api.setFilePmid.mockRejectedValue(new Error("No PubMed record has that PMID."));
    render(<View id={id} />);
    const dialog = await openUnmatched(1);

    fireEvent.change(within(dialog).getByPlaceholderText("PMID"), { target: { value: "1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Match" }));
    expect(await within(dialog).findByText("No PubMed record has that PMID.")).toBeTruthy();
  });

  it("scans the files no scan reached, and gives way to the scan's progress", async () => {
    fakePoll();
    const id = nextId++;
    api.getCollectionFiles.mockResolvedValue({ files: [row(1, id, "pending"), row(2, id, "pending")] });
    api.startImport.mockResolvedValue({ jobId: "job", total: 2 });
    render(<View id={id} />);
    const dialog = await openFiles("2 not scanned");

    api.getImportStatus.mockResolvedValue(job({ state: "running", total: 2, processed: 0, matched: 0 }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Scan them" }));
    await waitFor(() => expect(unmatchedDialog()).toBeNull());
    expect(api.startImport).toHaveBeenCalledWith(id);
    expect(screen.getByText(/Scanning 0 \/ 2/)).toBeTruthy();
  });

  it("says so inside itself when the scan won't start", async () => {
    const id = nextId++;
    api.getCollectionFiles.mockResolvedValue({ files: [row(1, id, "pending")] });
    api.startImport.mockRejectedValue(new Error("An import is already running for this collection."));
    render(<View id={id} />);
    const dialog = await openFiles("1 not scanned");

    const button = within(dialog).getByRole("button", { name: "Scan them" });
    fireEvent.click(button);
    expect(await within(dialog).findByText("An import is already running for this collection.")).toBeTruthy();
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
  });
});
