// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BookmarkFolderView } from "./BookmarkFolderView";
import { createImportJobs, type ImportJobs } from "../lib/import-jobs";
import type { BookmarkImport, FolderImportResponse, ImportJob } from "../types";

// A folder's reference-file import, from the folder's side: what it says the
// file left out, the count of entries PubMed didn't find, and the dialog where
// one is given a PMID — looked up and shown before anything is saved.
const api = vi.hoisted(() => ({
  getFolderImports: vi.fn(),
  getFolderImportStatus: vi.fn(),
  importToFolder: vi.fn(),
  startFolderImport: vi.fn(),
  lookUpImportPmid: vi.fn(),
  setImportPmid: vi.fn(),
  removeImport: vi.fn(),
  removeUnmatchedImports: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

let jobs: ImportJobs;
const papersAdded = vi.fn();

beforeEach(() => {
  api.getFolderImports.mockResolvedValue([]);
  api.getFolderImportStatus.mockResolvedValue({ state: "idle" });
  jobs = createImportJobs(api.getFolderImportStatus, () => {});
});

afterEach(() => {
  cleanup();
  jobs.stop();
  vi.resetAllMocks();
});

const settle = () => act(async () => {});

function entry(over: Partial<BookmarkImport>): BookmarkImport {
  return {
    id: 1,
    folder_id: 7,
    title: "Not indexed",
    authors: "Roe, R",
    journal: "Small Journal",
    year: "2019",
    doi: "10.1000/unknown",
    pmid: null,
    status: "unmatched",
    reason: "not-in-pubmed",
    added_at: "2026-11-04T00:00:00Z",
    ...over,
  };
}

const done: ImportJob = {
  jobId: "job",
  state: "done",
  total: 2,
  processed: 2,
  matched: 1,
  unmatched: 1,
  errors: 0,
  currentFile: null,
  startedAt: "2026-11-04T00:00:00Z",
  finishedAt: "2026-11-04T00:00:01Z",
};

async function view({ isAdmin = true } = {}) {
  const { container } = render(
    <BookmarkFolderView
      folderId={7}
      isAdmin={isAdmin}
      summary="3 papers"
      importJobs={jobs}
      onChanged={() => {}}
      onPapersAdded={papersAdded}
      onDeleted={() => {}}
    >
      <div />
    </BookmarkFolderView>
  );
  await settle();
  return container;
}

async function importFile(container: HTMLElement, res: Partial<FolderImportResponse>) {
  api.importToFolder.mockResolvedValue({
    read: 0,
    notArticles: 0,
    blank: 0,
    queued: 0,
    noIdentifier: 0,
    status: done,
    ...res,
  });
  const file = new File(["TY  - JOUR\nER  - "], "library.ris");
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  await settle();
}

describe("importing a reference file", () => {
  it("is one of the two ways in behind Add papers, and opens the file picker", async () => {
    await view();
    const pick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Add papers/ }),
      new MouseEvent("pointerdown", { bubbles: true })
    );
    expect(await screen.findByRole("menuitem", { name: "Paste DOIs or links…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Import a reference file (RIS, .nbib)…" }));
    expect(pick).toHaveBeenCalled();
    pick.mockRestore();
  });

  it("says what the file left out, and counts what PubMed didn't find", async () => {
    const container = await view();
    api.getFolderImports.mockResolvedValue([entry({})]);
    await importFile(container, { read: 5, notArticles: 2, blank: 1, queued: 2 });

    expect(
      screen.getByText("Skipped 2 that aren't journal articles. Skipped 1 with no title, DOI or PMID.")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 unmatched" })).toBeTruthy();
    // A lookup that was over before it could be followed still refreshes the folder.
    expect(papersAdded).toHaveBeenCalled();
  });

  it("says so when nothing in the file could be imported", async () => {
    const container = await view();
    await importFile(container, { read: 2, notArticles: 2 });
    expect(
      screen.getByText("Nothing in that file could be imported. Skipped 2 that aren't journal articles.")
    ).toBeTruthy();
  });

  it("offers neither the import nor the count to a viewer", async () => {
    api.getFolderImports.mockResolvedValue([entry({})]);
    await view({ isAdmin: false });
    expect(screen.queryByRole("button", { name: /Add papers/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /unmatched/ })).toBeNull();
  });
});

describe("an unmatched reference", () => {
  async function openDialog(): Promise<HTMLElement> {
    api.getFolderImports.mockResolvedValue([entry({})]);
    await view();
    fireEvent.click(screen.getByRole("button", { name: "1 unmatched" }));
    await settle();
    return screen.getByRole("dialog", { name: "Unmatched references" });
  }

  const paper = {
    pmid: "40000003",
    title: "The paper that PMID names",
    authors: ["Doe J"],
    journal_name: "Lancet",
    pub_date_display: "2021",
    url: "https://pubmed.ncbi.nlm.nih.gov/40000003/",
  };

  it("says why it wasn't found, and links to a PubMed search for its title", async () => {
    const dialog = await openDialog();
    expect(within(dialog).getByText("PubMed has no record of DOI 10.1000/unknown.")).toBeTruthy();
    const search = within(dialog).getByRole("link", { name: "Search PubMed" });
    expect(search.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/?term=Not%20indexed");
  });

  it("shows the paper a PMID names, and saves it only when told to", async () => {
    api.lookUpImportPmid.mockResolvedValue(paper);
    api.setImportPmid.mockResolvedValue(paper);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole("textbox", { name: /PMID for/ }), {
      target: { value: "40000003" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Find" }));
    await settle();

    expect(api.lookUpImportPmid).toHaveBeenCalledWith(1, "40000003");
    expect(within(dialog).getByText("The paper that PMID names")).toBeTruthy();
    expect(api.setImportPmid).not.toHaveBeenCalled();

    api.getFolderImports.mockResolvedValue([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await settle();
    expect(api.setImportPmid).toHaveBeenCalledWith(1, "40000003");
    expect(papersAdded).toHaveBeenCalled();
  });

  it("goes back to the box when the paper is the wrong one", async () => {
    api.lookUpImportPmid.mockResolvedValue(paper);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole("textbox", { name: /PMID for/ }), {
      target: { value: "40000003" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Find" }));
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Not this one" }));

    expect(within(dialog).queryByText("The paper that PMID names")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Find" })).toBeTruthy();
    expect(api.setImportPmid).not.toHaveBeenCalled();
  });

  it("shows a PMID PubMed doesn't know inside the dialog, and keeps the entry", async () => {
    api.lookUpImportPmid.mockRejectedValue(new Error("PubMed doesn't recognize PMID 49999999."));
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole("textbox", { name: /PMID for/ }), {
      target: { value: "49999999" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Find" }));
    await settle();
    expect(within(dialog).getByText("PubMed doesn't recognize PMID 49999999.")).toBeTruthy();
    expect(within(dialog).getByText("Not indexed")).toBeTruthy();
  });
});
