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
// reload through onCollectionChanged — or onFolderChanged, for a bookmark
// folder — and the token moves by exactly one.
function Host({ source, knownEmpty }: { source: PaperSource; knownEmpty?: boolean }) {
  const [token, setToken] = useState(0);
  const filters = usePaperFilters(source);
  return (
    <PapersTable
      source={source}
      reloadToken={token}
      knownEmpty={knownEmpty}
      isAdmin
      tokenRequired={false}
      libraryOpen
      onAuthRefreshed={() => {}}
      onCollectionChanged={() => setToken((t) => t + 1)}
      onFolderChanged={() => setToken((t) => t + 1)}
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

// The same control over a folder. What differs is everything the table says and
// calls, and none of how it behaves — so this pins the differences and leaves
// the dim, the held notice and the failure paths to the block above.
describe("removing papers from a bookmark folder", () => {
  let nextFolder = 900;
  let folder: number;

  beforeEach(() => {
    folder = nextFolder++;
    source = { folder };
    api.getPapers.mockReset();
  });

  it("offers the tick column and the button, and no bookmark control per row", async () => {
    api.getPapers.mockResolvedValue(THREE);
    const { container } = render(<Host source={source} />);
    await screen.findByText("Paper 1");

    expect(container.querySelectorAll(".select-cell input")).toHaveLength(3);
    expect(container.querySelectorAll(".bookmark-cell")).toHaveLength(0);
    // Drawn with nothing ticked, as it is in the Library, so it is there to find.
    expect((screen.getByText("Remove selected") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says what a folder loses, which is not what a collection does", async () => {
    api.getPapers.mockResolvedValue(THREE);
    const { container } = render(<Host source={source} />);
    await screen.findByText("Paper 1");

    fireEvent.click(container.querySelector<HTMLInputElement>(".select-cell input")!);
    fireEvent.click(await screen.findByText(/Remove 1 selected/));

    // No file is deleted from a folder, so the collection's line about stored
    // PDF copies would be a warning about something that cannot happen. The
    // title says all there is to say, and no line is drawn under it.
    const title = await screen.findByRole("heading", { name: "Remove 1 paper from this folder?" });
    expect(title.closest(".modal")!.querySelector(".modal-message")).toBeNull();
    expect(screen.queryByText(/stored PDF copies/)).toBeNull();
  });

  it("removes through the folder's route and reports what left it", async () => {
    const removal = deferred<{ removed: number }>();
    api.getPapers.mockResolvedValueOnce(THREE).mockResolvedValueOnce({
      papers: [paper("3")],
      journals: ["Lancet"],
    });
    api.removeBookmarks.mockReturnValue(removal.promise);

    const { container } = render(<Host source={source} />);
    await tickTwoAndConfirm(container);
    // One request for the ticked set, not one per paper — the whole point.
    expect(api.removeBookmarks).toHaveBeenCalledTimes(1);
    expect(api.removeBookmarks.mock.calls[0][0]).toBe(folder);
    expect([...api.removeBookmarks.mock.calls[0][1]].sort()).toEqual(["1", "2"]);
    expect(api.removeCollectionPapers).not.toHaveBeenCalled();

    await removal.land({ ok: true, value: { removed: 2 } });

    await waitFor(() => expect(screen.queryByText("Paper 1")).toBeNull());
    expect(await screen.findByText("Removed 2 papers from this folder.")).toBeTruthy();
    expect(dimmed(container)).toBe(0);
  });

  it("reports the shortfall when another tab got to one of them first", async () => {
    const removal = deferred<{ removed: number }>();
    api.getPapers.mockResolvedValueOnce(THREE).mockResolvedValueOnce({
      papers: [paper("3")],
      journals: ["Lancet"],
    });
    api.removeBookmarks.mockReturnValue(removal.promise);

    const { container } = render(<Host source={source} />);
    await tickTwoAndConfirm(container);
    await removal.land({ ok: true, value: { removed: 1 } });

    expect(
      await screen.findByText("Removed 1 paper from this folder. 1 had already left.")
    ).toBeTruthy();
  });
});

describe("a source the picker has already counted at zero", () => {
  // A load nothing lands, so the whole of what the skeleton is for — the gap
  // between mounting and the answer — is a state the test can stop in.
  const inFlight = () => {
    const load = deferred<typeof THREE>();
    api.getPapers.mockReturnValue(load.promise);
    return load;
  };
  const skeleton = () => screen.queryByLabelText("Loading papers");
  const filterSlots = (c: HTMLElement) =>
    c.querySelectorAll(".filter-picker[aria-hidden='true']").length;

  // mockReturnValue outlives vi.clearAllMocks, which is mockClear: it forgets
  // the calls and keeps the implementation. Left alone, the promise above stays
  // getPapers' answer for every test declared after this block, and one of those
  // hangs on its first findBy instead of failing on an assertion. The block that
  // installs a load nothing lands is the block that has to take it back.
  afterEach(() => {
    api.getPapers.mockReset();
  });

  it("opens on the empty state instead of the skeleton", async () => {
    const load = inFlight();
    render(<Host source={source} knownEmpty />);

    // Mid-fetch, and nothing is standing in for rows that aren't coming.
    expect(skeleton()).toBeNull();
    expect(screen.getByText("No papers yet.")).toBeTruthy();

    await load.land({ ok: true, value: { papers: [], journals: [] } });

    // The answer agrees, so the frame already on screen is the one it keeps.
    expect(skeleton()).toBeNull();
    expect(screen.getByText("No papers yet.")).toBeTruthy();
  });

  // The other half of the same frame. The body is the visible one, but the
  // toolbar reserves slots too, and on a source counted at zero neither is
  // waiting for anything: no journals arrive with the papers, and the facet
  // fetch answers with nothing filed. A stand-in there shimmers and is then
  // removed, having held a line for a control that was never coming.
  it("reserves no filter slots either", async () => {
    const load = inFlight();
    const { container } = render(<Host source={source} knownEmpty />);

    expect(filterSlots(container)).toBe(0);

    await load.land({ ok: true, value: { papers: [], journals: [] } });
    expect(filterSlots(container)).toBe(0);
  });

  it("still reserves them when the count isn't known", async () => {
    // The control case, so the assertion above is about knownEmpty rather than
    // about a toolbar that draws no stand-ins here under any conditions.
    const load = inFlight();
    const { container } = render(<Host source={source} />);

    expect(filterSlots(container)).toBeGreaterThan(0);
    await load.land({ ok: true, value: { papers: [], journals: [] } });
  });

  it("is a hint, not an assertion: papers still win", async () => {
    // The stale-count case. Claiming emptiness must not survive an answer that
    // disagrees — this is the whole reason it isn't seeded into the cache.
    const load = inFlight();
    render(<Host source={source} knownEmpty />);
    expect(screen.getByText("No papers yet.")).toBeTruthy();

    await load.land({ ok: true, value: THREE });

    expect(await screen.findByText("Paper 1")).toBeTruthy();
    expect(screen.queryByText("No papers yet.")).toBeNull();
  });

  it("still skeletons when the count isn't known", async () => {
    const load = inFlight();
    render(<Host source={source} />);

    expect(skeleton()).toBeTruthy();
    expect(screen.queryByText("No papers yet.")).toBeNull();

    await load.land({ ok: true, value: { papers: [], journals: [] } });

    expect(skeleton()).toBeNull();
    expect(screen.getByText("No papers yet.")).toBeTruthy();
  });
});

describe("a viewport too narrow for the Authors column", () => {
  // jsdom has no matchMedia, so the table is wide unless a test says otherwise.
  // One switch for every query rather than a set of matching ones: the table
  // asks a single question, and answering it by its text would mean writing
  // the width here that the table is the one place for.
  function stubViewport(narrow: boolean) {
    const listeners = new Set<() => void>();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        get matches() {
          return narrow;
        },
        addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
      }),
    });
    return {
      resize: (to: "narrow" | "wide") =>
        act(() => {
          narrow = to === "narrow";
          listeners.forEach((fn) => fn());
        }),
    };
  }

  // Three papers whose three orders all differ: by year descending 1, 2, 3; by
  // first author 2, 3, 1; by year ascending 3, 2, 1.
  const SORTABLE = {
    papers: [
      { ...paper("1"), authors: ["Zed"], pub_date: "2024-01-01" },
      { ...paper("2"), authors: ["Adams"], pub_date: "2023-01-01" },
      { ...paper("3"), authors: ["Moss"], pub_date: "2022-01-01" },
    ],
    journals: ["Lancet"],
  };
  const order = (c: HTMLElement) =>
    [...c.querySelectorAll("tbody.paper-rows")].map((r) => r.textContent!.match(/Paper (\d)/)![1]);
  const header = (name: string) =>
    [...document.querySelectorAll("thead th")].find((th) => th.textContent === name) ?? null;
  const sortedBy = () => document.querySelector("thead th .sort-arrow")?.closest("th")?.textContent;

  beforeEach(() => {
    api.getPapers.mockResolvedValue(SORTABLE);
  });
  afterEach(() => {
    api.getPapers.mockReset();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("drops the column, and says so to the stylesheet", async () => {
    // The class is the stylesheet's half of the layout: it tightens the headers
    // and lets Links wrap on `.narrow`, and has no breakpoint of its own.
    const viewport = stubViewport(true);
    const { container } = render(<Host source={source} />);
    await screen.findByText("Paper 1");

    expect(header("Authors")).toBeNull();
    expect(container.querySelector("table")!.className).toBe("papers-table narrow");

    viewport.resize("wide");
    expect(header("Authors")).not.toBeNull();
    expect(container.querySelector("table")!.className).toBe("papers-table");
  });

  it("goes back to the opening order while the column it was sorted by is away", async () => {
    // Sorted by Authors, then narrowed. The rows used to stay in author order
    // with no arrow anywhere and no Authors header to click to change it.
    const viewport = stubViewport(false);
    const { container } = render(<Host source={source} />);
    await screen.findByText("Paper 1");
    fireEvent.click(header("Authors")!);
    expect(order(container)).toEqual(["2", "3", "1"]);

    viewport.resize("narrow");
    expect(order(container)).toEqual(["1", "2", "3"]);
    expect(sortedBy()).toBe("Year");

    // Not forgotten: the sort comes back with the header that shows it.
    viewport.resize("wide");
    expect(order(container)).toEqual(["2", "3", "1"]);
    expect(sortedBy()).toBe("Authors");
  });

  it("flips the order on screen when its header is clicked meanwhile", async () => {
    // The arrow is on Year while the pick is still Authors, and a click on
    // Year has to act on what the arrow shows.
    const viewport = stubViewport(false);
    const { container } = render(<Host source={source} />);
    await screen.findByText("Paper 1");
    fireEvent.click(header("Authors")!);
    viewport.resize("narrow");

    fireEvent.click(header("Year")!);
    expect(order(container)).toEqual(["3", "2", "1"]);
    expect(sortedBy()).toBe("Year");

    // And that click was a pick of its own, so widening no longer undoes it.
    viewport.resize("wide");
    expect(order(container)).toEqual(["3", "2", "1"]);
    expect(sortedBy()).toBe("Year");
  });
});
