// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MAX_LINKS_PER_REQUEST } from "../../../shared/limits";
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

function paste(lines: string[]) {
  const onAdded = vi.fn();
  const view = render(<AddLinks open onClose={() => {}} folderId={7} onAdded={onAdded} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: lines.join("\n") } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  return { onAdded, view };
}

// Lets the loop run on past a settled request to its next await.
const settle = () => act(async () => {});

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
