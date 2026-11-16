// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createSources, SourcesContext, type Sources } from "../lib/sources";
import { createTestApi } from "../test-api";
import { HaveCheck } from "./HaveCheck";

// The check-holdings dialog over a library held in memory (test-api.ts): what
// it says each pasted line is, and the copy from the organization's library —
// where it may go, what the dialog says while it moves, and what it says once
// it has.

const served = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  // Methods asked for that test-api.ts doesn't answer, which hang rather than
  // fail so the dialog isn't sent down its error path instead.
  unanswered: [] as string[],
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: new Proxy(
    {},
    {
      get: (_, name: string) =>
        served.api[name] ??
        (() => {
          served.unanswered.push(name);
          return new Promise(() => {});
        }),
    }
  ),
}));

let server: ReturnType<typeof createTestApi>;
let sources: Sources;

beforeEach(() => {
  server = createTestApi();
  served.api = server.api;
  served.unanswered = [];
});

afterEach(() => {
  cleanup();
  expect(served.unanswered).toEqual([]);
});

const link = (pmid: string) => `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

function open({ isAdmin = true } = {}) {
  sources = createSources(server.api);
  const access = { isAdmin, tokenRequired: false, libraryOpen: false, onAuthRefreshed: () => {} };
  const dialog = (open: boolean) => (
    <SourcesContext.Provider value={sources}>
      <HaveCheck open={open} onClose={() => {}} access={access} />
    </SourcesContext.Provider>
  );
  const { rerender } = render(dialog(true));
  return { close: () => rerender(dialog(false)), reopen: () => rerender(dialog(true)) };
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const click = async (el: HTMLElement) => {
  await act(async () => fireEvent.click(el));
  await settle();
};

async function check(...lines: string[]) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: lines.join("\n") } });
  await click(screen.getByRole("button", { name: /^Check/ }));
}

const summary = () => document.querySelector(".have-summary")?.textContent;
const rows = () => [...document.querySelectorAll<HTMLElement>(".have-row")];
const verdicts = () => rows().map((r) => r.querySelector(".have-pill")!.textContent!.trim());
const offer = (row = rows()[0]) =>
  within(row).queryByRole<HTMLButtonElement>("button", { name: "Copy to my library" });
const copyButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Copy" });
const destinations = () => screen.queryAllByRole("checkbox").map((c) => c.closest("label")!.textContent);
// The dialog's own banner, and the destination picker's.
const banner = () =>
  [...document.querySelectorAll(".banner")].find((b) => !b.closest(".have-dest"))?.textContent ?? null;
const pickerBanner = () => document.querySelector(".have-dest .banner")?.textContent ?? null;

// A paper the organization holds and this library doesn't, with the picker
// open on its row.
async function choosing(pmid = "3") {
  server.library.orgHolds.add(pmid);
  open();
  await check(link(pmid));
  await click(offer()!);
}

function shared(name: string): number {
  const id = server.addCollection(name);
  server.library.shared.add(id);
  return id;
}

describe("the answers", () => {
  it("say, line by line, what this library, another workspace and the organization hold", async () => {
    const notes = server.addCollection("Notes");
    Object.assign(server.addFile(notes, "held.pdf"), { pmid: "1", match_status: "matched" });
    server.library.elsewhere.set("2", { workspace: "Acme", collection: "Reviews" });
    server.library.orgHolds.add("3");
    open();
    await check(link("1"), link("2"), link("3"), link("4"), "Smith et al. 2019");
    expect(verdicts()).toEqual([
      "In your library",
      "In another workspace",
      "In your organization",
      "Not in your library",
      "Couldn’t read this",
    ]);
    expect(summary()).toBe(
      "1 of 5 already in your library. You already own 1 more, in another workspace. " +
        "1 more is held by your organization. 1 line couldn’t be read."
    );
    expect(rows()[0].textContent).toContain("held.pdf — in Notes");
    expect(rows()[1].textContent).toContain("Exists in Acme workspace, under “Reviews”.");
  });

  // "Not in your library" is the answer that ends in a purchase, so it is
  // never given when the organization didn't answer.
  it("don't say a paper isn't held when the organization couldn't be asked", async () => {
    server.library.orgUnreachable = true;
    open();
    await check(link("4"));
    expect(verdicts()).toEqual(["Couldn’t check everywhere"]);
    expect(summary()).toBe("0 of 1 already in your library. 1 couldn’t be checked everywhere.");
  });

  it("are kept when the dialog is closed and opened again", async () => {
    server.library.orgHolds.add("3");
    const dialog = open();
    await check(link("3"));
    dialog.close();
    dialog.reopen();
    await settle();
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(link("3"));
    expect(verdicts()).toEqual(["In your organization"]);
  });
});

describe("a copy from the organization", () => {
  it("is offered only to someone who can change this library", async () => {
    server.library.orgHolds.add("3");
    open({ isAdmin: false });
    await check(link("3"));
    expect(offer()).toBeNull();
    expect(rows()[0].textContent).toContain("Held by The organization. Ask your project manager for a copy.");
  });

  it("goes only into a collection shared with the organization paired now", async () => {
    shared("Thesis");
    server.addCollection("Drafts");
    const old = server.addCollection("Old engagement");
    server.library.sharedBefore.add(old);
    shared("Notes");
    await choosing();
    expect(destinations()).toEqual(["Thesis", "Notes"]);
  });

  // The answers are kept while the dialog is closed, so what is shared may
  // have changed since the check ran.
  it("offers what is shared when the picker opens, not when the check ran", async () => {
    shared("Notes");
    server.library.orgHolds.add("3");
    open();
    await check(link("3"));
    shared("Thesis");
    await click(offer()!);
    expect(destinations()).toEqual(["Notes", "Thesis"]);
  });

  it("files into the collections ticked, and then says the library holds it", async () => {
    const thesis = shared("Thesis");
    const notes = shared("Notes");
    await choosing();
    expect(copyButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Notes" }));
    const release = server.hold("proPull");
    await click(copyButton());

    // On its way: the row says so, and the headline still has it as the
    // organization's.
    expect(within(rows()[0]).getByRole("button", { name: "Copying…" })).toBeTruthy();
    expect(summary()).toBe("0 of 1 already in your library. 1 more is held by your organization.");

    release();
    await settle();
    expect(verdicts()).toEqual(["In your library"]);
    expect(summary()).toBe("1 of 1 already in your library.");
    expect(rows()[0].textContent).toContain("3.pdf — in Notes");
    expect(server.library.files.map((f) => f.collection_id)).toEqual([notes]);
    // Stale wherever it is shown, and only where it went.
    expect(sources.tokenFor({ collection: notes })).toBe(1);
    expect(sources.tokenFor({ collection: thesis })).toBe(0);
  });

  it("is taken one at a time", async () => {
    shared("Notes");
    server.library.orgHolds.add("3").add("5");
    open();
    await check(link("3"), link("5"));
    await click(offer(rows()[0])!);
    fireEvent.click(screen.getByRole("checkbox", { name: "Notes" }));
    const release = server.hold("proPull");
    await click(copyButton());
    expect(offer(rows()[1])!.disabled).toBe(true);
    release();
    await settle();
    expect(offer(rows()[1])!.disabled).toBe(false);
  });

  // The one thing the re-check after a copy can't say: why the paper didn't
  // land, when the copy itself succeeded.
  it("says what it warned about, and is offered again when the paper didn't land", async () => {
    const notes = shared("Notes");
    Object.assign(server.addFile(notes, "3.pdf"), { pmid: "9", match_status: "matched", match_method: "manual" });
    await choosing();
    fireEvent.click(screen.getByRole("checkbox", { name: "Notes" }));
    await click(copyButton());
    expect(banner()).toBe("Notes already holds this file, matched by hand.");
    expect(verdicts()).toEqual(["In your organization"]);
    expect(offer()!.disabled).toBe(false);
  });

  it("says why it failed, and can be tried again", async () => {
    shared("Notes");
    await choosing();
    fireEvent.click(screen.getByRole("checkbox", { name: "Notes" }));
    server.fail("proPull", "The organization couldn't be reached.");
    await click(copyButton());
    expect(banner()).toBe("The organization couldn't be reached.");
    expect(verdicts()).toEqual(["In your organization"]);
    expect(copyButton().disabled).toBe(false);
  });
});

describe("the picker", () => {
  it("makes, shares and ticks a collection named in it", async () => {
    await choosing();
    expect(screen.getByText("No collections are shared with your organization yet — name one below.")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("New collection"), { target: { value: "Grants" } });
    await click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Grants" }).checked).toBe(true);
    const grants = server.library.collections.find((c) => c.name === "Grants")!.id;
    expect(server.library.shared.has(grants)).toBe(true);
    expect(sources.collections().map((c) => c.name)).toEqual(["Grants"]);
    await click(copyButton());
    expect(verdicts()).toEqual(["In your library"]);
  });

  // It exists, so its name is taken; but a copy can't go into it, so it isn't
  // offered.
  it("says a collection it made couldn't be shared, and doesn't offer it", async () => {
    server.fail("proShareCollection", "The organization refused it.");
    await choosing();
    fireEvent.change(screen.getByPlaceholderText("New collection"), { target: { value: "Grants" } });
    await click(screen.getByRole("button", { name: "Create" }));
    expect(pickerBanner()).toBe(
      "Created “Grants”, but sharing it with your organization failed: The organization refused it. " +
        "Copies can only go to a shared collection — share it in Settings, then check again."
    );
    expect(destinations()).toEqual([]);
    expect(sources.collections().map((c) => c.name)).toEqual(["Grants"]);
  });

  // The check succeeded; only the next step can't be taken.
  it("says the shared collections couldn't be loaded, without a banner over the answers", async () => {
    shared("Notes");
    server.fail("proSync");
    await choosing();
    expect(banner()).toBeNull();
    expect(document.querySelector(".have-dest-failed")!.textContent).toContain(
      "Couldn’t load your shared collections: The server couldn't be reached."
    );
    server.recover("proSync");
    await click(screen.getByRole("button", { name: "Try again" }));
    expect(document.querySelector(".have-dest-failed")).toBeNull();
    expect(destinations()).toEqual(["Notes"]);
  });
});
