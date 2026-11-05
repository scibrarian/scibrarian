// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MAX_LINKS, MAX_LINKS_PER_REQUEST } from "../../../shared/limits";
import type { AddLinksResponse, LinkAnswer, LinkOutcome } from "../types";
import { AddLinks } from "./AddLinks";

// The batch loop behind a long paste. The server is mocked: each request is a
// promise the test settles, so it decides when a batch lands relative to the
// dialog going away.

const addBookmarkLinks = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api: { addBookmarkLinks } }));

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function answer(input: string, outcome: LinkOutcome): LinkAnswer {
  return {
    parsed: { kind: "pmid", input, pmid: "1" },
    outcome,
    paper:
      outcome === "added"
        ? { pmid: "1", title: "Paper", authors: [], journal_name: "", pub_date_display: "", url: "" }
        : null,
  };
}

function response(lines: string[], outcome: LinkOutcome = "added"): AddLinksResponse {
  return { results: lines.map((l) => answer(l, outcome)), truncated: 0 };
}

// Two batches' worth: one full, one of five.
const LINES = Array.from(
  { length: MAX_LINKS_PER_REQUEST + 5 },
  (_, i) => `https://pubmed.ncbi.nlm.nih.gov/${40000000 + i}/`
);

// A paste of n lines, numbered apart from LINES — for one past the limit.
function longPaste(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://pubmed.ncbi.nlm.nih.gov/${41000000 + i}/`);
}

let batches: ReturnType<typeof deferred<AddLinksResponse>>[];

beforeEach(() => {
  batches = [];
  addBookmarkLinks.mockReset();
  addBookmarkLinks.mockImplementation(() => {
    const d = deferred<AddLinksResponse>();
    batches.push(d);
    return d.promise;
  });
});

function submit(lines: string[]) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: lines.join("\n") } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
}

function paste(lines: string[]) {
  const onAdded = vi.fn();
  const view = render(<AddLinks open onClose={() => {}} folderId={7} onAdded={onAdded} />);
  submit(lines);
  return { onAdded, view };
}

// Lets the loop run on past a settled request to its next await.
const settle = () => act(async () => {});

// Lands each batch of a paste as it is sent, every line of it added.
async function landAll(lines: string[]) {
  for (let i = 0; i < Math.min(lines.length, MAX_LINKS); i += MAX_LINKS_PER_REQUEST) {
    batches.at(-1)!.resolve(response(lines.slice(i, i + MAX_LINKS_PER_REQUEST)));
    await settle();
  }
}

describe("AddLinks' batches", () => {
  it("sends them in turn and refreshes the folder once, after the last", async () => {
    const { onAdded } = paste(LINES);
    batches[0].resolve(response(LINES.slice(0, MAX_LINKS_PER_REQUEST)));
    await settle();
    // Per batch, the reloads overlapped and could land out of order.
    expect(onAdded).not.toHaveBeenCalled();
    expect(addBookmarkLinks).toHaveBeenCalledTimes(2);
    batches[1].resolve(response(LINES.slice(MAX_LINKS_PER_REQUEST)));
    await settle();
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it("doesn't refresh the folder when nothing was added", async () => {
    const { onAdded } = paste(LINES.slice(0, 2));
    batches[0].resolve(response(LINES.slice(0, 2), "already-saved"));
    await settle();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("sends no more once the dialog is gone, and still refreshes for the batch in flight", async () => {
    // Leaving the folder unmounts the dialog — the folder view is keyed by it.
    const { onAdded, view } = paste(LINES);
    view.unmount();
    batches[0].resolve(response(LINES.slice(0, MAX_LINKS_PER_REQUEST)));
    await settle();
    expect(addBookmarkLinks).toHaveBeenCalledTimes(1);
    // That batch's papers were saved, so the bookmark icons and folder counts
    // elsewhere still need to hear about them.
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it("refreshes once for the batches that landed before one failed", async () => {
    const { onAdded } = paste(LINES);
    batches[0].resolve(response(LINES.slice(0, MAX_LINKS_PER_REQUEST)));
    await settle();
    batches[1].reject(new Error("Couldn’t reach PubMed."));
    await settle();
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Couldn’t reach PubMed/)).toBeTruthy();
  });
});

describe("AddLinks' paste box and rows", () => {
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

  it("empties the box once every line is in the folder, and puts the cursor in it", async () => {
    paste(LINES.slice(0, 2));
    box().blur();
    batches[0].resolve({
      results: [answer(LINES[0], "added"), answer(LINES[1], "already-saved")],
      truncated: 0,
    });
    await settle();
    expect(box().value).toBe("");
    expect(document.activeElement).toBe(box());
  });

  it("keeps only the lines that didn't get in", async () => {
    paste(LINES.slice(0, 3));
    batches[0].resolve({
      results: [
        answer(LINES[0], "added"),
        answer(LINES[1], "not-in-pubmed"),
        answer(LINES[2], "already-saved"),
      ],
      truncated: 0,
    });
    await settle();
    expect(box().value).toBe(LINES[1]);
  });

  it("keeps the lines past the limit, and sends them next", async () => {
    const long = longPaste(MAX_LINKS + 2);
    paste(long);
    await landAll(long);
    expect(box().value).toBe(long.slice(MAX_LINKS).join("\n"));
    // Kept whole, Add sent the first 300 again and never reached these.
    fireEvent.submit(box().closest("form")!);
    expect(addBookmarkLinks).toHaveBeenLastCalledWith(7, long.slice(MAX_LINKS));
  });

  it("keeps what a failed batch never sent, after the lines that didn't get in", async () => {
    paste(LINES);
    batches[0].resolve({
      results: LINES.slice(0, MAX_LINKS_PER_REQUEST).map((l, i) =>
        answer(l, i === 3 ? "not-in-pubmed" : "added")
      ),
      truncated: 0,
    });
    await settle();
    batches[1].reject(new Error("Couldn’t reach PubMed."));
    await settle();
    expect(box().value).toBe([LINES[3], ...LINES.slice(MAX_LINKS_PER_REQUEST)].join("\n"));
  });

  it("leaves the box as typed when nothing got in", async () => {
    render(<AddLinks open onClose={() => {}} folderId={7} onAdded={() => {}} />);
    const typed = `  ${LINES[0]}\n\n${LINES[1]}`;
    fireEvent.change(box(), { target: { value: typed } });
    fireEvent.submit(box().closest("form")!);
    batches[0].reject(new Error("Couldn’t reach PubMed."));
    await settle();
    expect(box().value).toBe(typed);
  });

  it("keeps an edit made while the batches went", async () => {
    paste(LINES.slice(0, 1));
    fireEvent.change(box(), { target: { value: "edited" } });
    batches[0].resolve(response(LINES.slice(0, 1)));
    await settle();
    expect(box().value).toBe("edited");
  });

  it("takes the last paste's rows down as the next one starts", async () => {
    paste(LINES.slice(0, 2));
    batches[0].resolve(response(LINES.slice(0, 2)));
    await settle();
    submit(LINES.slice(2, 3));
    // Left up under "Adding…", they read as this paste's answers.
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByText(/added to this folder/)).toBeNull();
    batches[1].resolve(response(LINES.slice(2, 3), "already-saved"));
    await settle();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("takes the last paste's over-the-limit line down with its rows", async () => {
    const long = longPaste(MAX_LINKS + 1);
    paste(long);
    await landAll(long);
    expect(screen.getByText(/1 more line wasn’t added/)).toBeTruthy();
    // A paste under the limit, which never hit it.
    submit(LINES.slice(0, 1));
    expect(screen.queryByText(/more line/)).toBeNull();
  });

  it("takes the last paste's rows down when the next one fails before any land", async () => {
    paste(LINES.slice(0, 2));
    batches[0].resolve(response(LINES.slice(0, 2)));
    await settle();
    submit(LINES.slice(2, 3));
    batches[1].reject(new Error("Couldn’t reach PubMed."));
    await settle();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

// Add is disabled while a paste runs, so whoever pressed it from the keyboard
// is left with focus on nothing; the box is where they type next.
describe("AddLinks' focus", () => {
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  const addButton = () => screen.getByRole("button", { name: /^Add/ });

  it("opens on the box", async () => {
    render(<AddLinks open onClose={() => {}} folderId={7} onAdded={() => {}} />);
    await settle();
    expect(document.activeElement).toBe(box());
  });

  it("goes back to the box when lines are left in it to correct", async () => {
    paste(LINES.slice(0, 2));
    box().blur();
    batches[0].resolve({
      results: [answer(LINES[0], "added"), answer(LINES[1], "not-in-pubmed")],
      truncated: 0,
    });
    await settle();
    expect(document.activeElement).toBe(box());
  });

  it("goes back to the box after a batch failed", async () => {
    paste(LINES);
    box().blur();
    batches[0].resolve(response(LINES.slice(0, MAX_LINKS_PER_REQUEST)));
    await settle();
    batches[1].reject(new Error("Couldn’t reach PubMed."));
    await settle();
    expect(document.activeElement).toBe(box());
  });

  it("takes it back from the Add button the run disabled", async () => {
    render(<AddLinks open onClose={() => {}} folderId={7} onAdded={() => {}} />);
    fireEvent.change(box(), { target: { value: LINES[0] } });
    addButton().focus();
    fireEvent.submit(box().closest("form")!);
    batches[0].resolve(response(LINES.slice(0, 1)));
    await settle();
    expect(document.activeElement).toBe(box());
  });

  it("takes it back from the dialog, where the rows coming down put it", async () => {
    paste(LINES.slice(0, 2));
    batches[0].resolve(response(LINES.slice(0, 2)));
    await settle();
    box().blur();
    submit(LINES.slice(2, 3));
    await settle();
    // Radix's trap, finding focus on the page as nodes leave the dialog.
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    batches[1].resolve(response(LINES.slice(2, 3)));
    await settle();
    expect(document.activeElement).toBe(box());
  });

  it("stays where the reader moved it while the batches went", async () => {
    paste(LINES);
    batches[0].resolve(response(LINES.slice(0, MAX_LINKS_PER_REQUEST)));
    await settle();
    const title = screen.getAllByRole("button", { name: "Paper" })[0];
    title.focus();
    batches[1].resolve(response(LINES.slice(MAX_LINKS_PER_REQUEST)));
    await settle();
    expect(document.activeElement).toBe(title);
  });
});
