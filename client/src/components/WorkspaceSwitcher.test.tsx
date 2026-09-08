// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deleteWarning, WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { describeResetDone } from "../lib/format";
import type { Workspace } from "../types";

afterEach(cleanup);

const api = vi.hoisted(() => ({
  getWorkspaces: vi.fn(),
  renameWorkspace: vi.fn(),
  workspaceContents: vi.fn(),
}));

vi.mock("../api", () => ({ api }));

const ROWS: Workspace[] = [
  { id: "a", name: "Bristol", created_at: "2026-01-01T00:00:00.000Z", active: true },
  { id: "b", name: "Acme", created_at: "2026-01-02T00:00:00.000Z", active: false },
];

describe("what the delete confirmation says", () => {
  it("names the counts when they are known", () => {
    expect(deleteWarning({ collections: 2, files: 4 })).toContain(
      "its whole library — 2 collections and 4 stored PDFs"
    );
  });

  it("says so when there is nothing in it", () => {
    expect(deleteWarning({ collections: 0, files: 0 })).toContain("This workspace is empty");
  });

  // Two states, one wording, and it has to be the wider one: the counts have
  // not arrived yet, or the database could not be read to produce them. Neither
  // may claim a size it cannot support.
  it("falls back to the shape of the loss when the counts are absent", () => {
    expect(deleteWarning(null)).toContain("every collection and every stored PDF");
  });

  // The rule this now shares with the reset report and the collection removal.
  // Three messages about the same kind of rows, from three ends of the app, and
  // this one spelled the pluralisation out for itself until it didn't — which
  // is how "1204 stored PDFs" ended up beside Settings' "1,204 papers".
  // Asserted against the other spelling, because either alone goes green on its
  // own.
  it("writes a large count the way the reset report writes it", () => {
    expect(deleteWarning({ collections: 1, files: 1204 })).toContain(
      "1 collection and 1,204 stored PDFs"
    );
    // collections > 0 because the reset report nests the file count inside the
    // collections clause — the files are what is *in* them, not a sixth kind of
    // thing. The separator is the part both have to agree on.
    expect(
      describeResetDone({
        topics: 0,
        journals: 0,
        papers: 0,
        folders: 0,
        collections: 1,
        files: 1204,
      })
    ).toContain("1,204 stored files");
  });
});

describe("a refusal that is no longer true", () => {
  // It had no way to go. run() cleared it only on a success, so a name clash
  // stood in the header through every cancel and every reopen until some later
  // mutation happened to succeed — and beside "Switching…", which renders as
  // the next span along, it read as one sentence made of two unrelated states.
  it("is cleared when the dialog that caused it is dismissed", async () => {
    api.getWorkspaces.mockResolvedValue({ workspaces: ROWS });
    api.renameWorkspace.mockRejectedValue(new Error('There is already a workspace called "Acme".'));

    render(<WorkspaceSwitcher />);
    await screen.findByText("Bristol");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Workspace:/ }),
      new MouseEvent("pointerdown", { bubbles: true })
    );
    fireEvent.click(await screen.findByLabelText("Rename Acme"));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Bristol" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    const message = await screen.findByText(/already a workspace/);
    expect(message).toBeTruthy();

    // Reopen and back out: the message belongs to the attempt, not to the header.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Workspace:/ }),
      new MouseEvent("pointerdown", { bubbles: true })
    );
    fireEvent.click(await screen.findByLabelText("Rename Acme"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText(/already a workspace/)).toBeNull());
  });
});
