// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePaperFilters } from "../lib/papers";
import type { Paper, PaperSource } from "../types";
import { PapersTable } from "./PapersTable";

// Anything the table's subtree reaches for is stubbed; the two that matter are
// set per test. A proxy rather than a fixed list, so a control added inside the
// table later fails on its own assertion rather than on an undefined method.
const api = vi.hoisted(() => {
  const store: Record<string, ReturnType<typeof vi.fn>> = {};
  return new Proxy(store, {
    get(target, prop: string) {
      target[prop] ??= vi.fn(async () => ({}));
      return target[prop];
    },
  }) as unknown as Record<string, ReturnType<typeof vi.fn>>;
});
vi.mock("../api", () => ({ api }));

// The one stub whose shape is read on every render rather than only when a
// control is opened: PaperFilters asks whether this source has any MeSH filing
// at all before it decides to draw the subject filter.
const NO_MESH = { headings: [], filing: { filed: 0, unchecked: 0 } };

const paper = (pmid: string): Paper => ({
  pmid,
  title: `Paper ${pmid}`,
  journal_name: "Lancet",
  authors: [],
  pub_date: "2024-01-01",
  pub_date_display: "2024",
  doi: "",
  url: "",
  citation_count: 0,
  file_id: null,
  file_name: null,
  file_exists: false,
  collections: [],
  snippet: null,
});

const THREE = { papers: [paper("1"), paper("2"), paper("3")], journals: ["Lancet"] };

// A removal the test decides the ending of, so the moment between the click and
// the server answering — the whole of what the dim is feedback for — is a state
// the test can stop in and look at.
function deferred<T>() {
  let settle!: (r: { ok: true; value: T } | { ok: false; error: unknown }) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = (r) => (r.ok ? resolve(r.value) : reject(r.error));
  });
  // The rejection is always awaited through `land`, but nothing has attached a
  // handler yet at the moment it is created.
  promise.catch(() => {});
  return {
    promise,
    land: async (r: { ok: true; value: T } | { ok: false; error: unknown }) => {
      await act(async () => {
        settle(r);
        await promise.catch(() => {});
      });
    },
  };
}

// A shell that owns the reload token, the way App does: the table asks for a
// reload through onCollectionChanged and the token moves by exactly one.
function Host({ source }: { source: PaperSource }) {
  const [token, setToken] = useState(0);
  const filters = usePaperFilters(source);
  return (
    <PapersTable
      source={source}
      reloadToken={token}
      isAdmin
      tokenRequired={false}
      libraryOpen
      onAuthRefreshed={() => {}}
      onCollectionChanged={() => setToken((t) => t + 1)}
      filters={filters}
      bookmarking={null}
    />
  );
}

const dimmed = (c: HTMLElement) => c.querySelectorAll(".paper-rows.leaving").length;

// Each test gets its own collection id: usePapers caches by (source, token) in
// a module-level map that outlives a test file.
let nextCollection = 900;
let source: PaperSource;

beforeEach(() => {
  source = { collection: nextCollection++ };
  api.getMeshHeadings.mockResolvedValue(NO_MESH);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Tick two of the three rows and confirm, without waiting for the request: the
// removal is left in flight for the caller to land.
async function tickTwoAndConfirm(container: HTMLElement) {
  await screen.findByText("Paper 1");
  const boxes = container.querySelectorAll<HTMLInputElement>(".select-cell input");
  fireEvent.click(boxes[0]);
  fireEvent.click(boxes[1]);
  fireEvent.click(await screen.findByText(/Remove 2 selected/));
  // The confirm dialog is portalled out of the container.
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  // The dim is feedback for the click, so it is on before the server answers.
  await waitFor(() => expect(dimmed(container)).toBe(2));
}

describe("removing papers from a collection", () => {
  it("dims the rows on the click and drops them when the reload lands", async () => {
    const removal = deferred<{ removed: number; papers: number }>();
    api.getPapers.mockResolvedValueOnce(THREE).mockResolvedValueOnce({
      papers: [paper("3")],
      journals: ["Lancet"],
    });
    api.removeCollectionPapers.mockReturnValue(removal.promise);

    const { container } = render(<Host source={source} />);
    await tickTwoAndConfirm(container);
    await removal.land({ ok: true, value: { removed: 2, papers: 2 } });

    await waitFor(() => expect(screen.queryByText("Paper 1")).toBeNull());
    // findBy, not getBy: the banner takes its own copy of the message in an
    // effect, so the text arrives a tick after the rows go.
    expect(await screen.findByText("Removed 2 papers from this collection.")).toBeTruthy();
    expect(dimmed(container)).toBe(0);
  });

  it("releases the dim when the reload fails, and claims nothing", async () => {
    // The hang this covers. usePapers keeps the last good list on screen when a
    // reload fails, so the removed rows are still there — and the token moved by
    // exactly one, so the escape for a later refresh was never going to fire
    // either. The ids sat in `leaving` with nothing left to release them.
    const removal = deferred<{ removed: number; papers: number }>();
    api.getPapers.mockResolvedValueOnce(THREE).mockRejectedValueOnce(new Error("Couldn't load."));
    api.removeCollectionPapers.mockReturnValue(removal.promise);

    const { container } = render(<Host source={source} />);
    await tickTwoAndConfirm(container);
    await removal.land({ ok: true, value: { removed: 2, papers: 2 } });

    await screen.findByText("Couldn't load.");
    // The rows are still on screen, because the list on screen is the stale one.
    expect(screen.getByText("Paper 1")).toBeTruthy();
    // But nothing is still pretending to be on its way out...
    await waitFor(() => expect(dimmed(container)).toBe(0));
    // ...and no success is claimed over rows that are visibly still there.
    expect(screen.queryByText(/^Removed 2 papers/)).toBeNull();
  });

  it("puts the rows back to full strength when the request itself fails", async () => {
    const removal = deferred<{ removed: number; papers: number }>();
    api.getPapers.mockResolvedValue(THREE);
    api.removeCollectionPapers.mockReturnValue(removal.promise);

    const { container } = render(<Host source={source} />);
    await tickTwoAndConfirm(container);
    await removal.land({ ok: false, error: new Error("Nope.") });

    await screen.findByText("Nope.");
    // Nothing left the collection, so nothing should still look like it is
    // about to — and the ticks stay put so the same removal can be retried.
    await waitFor(() => expect(dimmed(container)).toBe(0));
    expect(screen.getByText(/Remove 2 selected/)).toBeTruthy();
  });
});
