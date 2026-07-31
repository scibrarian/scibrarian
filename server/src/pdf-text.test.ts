import { describe, expect, test } from "vitest";
import { collectPages } from "./pdf-text.js";

// The two caps in collectPages pull in opposite directions — one bounds cost,
// one is a correctness constraint — and the document that tells them apart has
// two million characters on its first page, which is not something to keep as a
// fixture. Feeding synthetic pages exercises the real walk instead.

const MATCH_PAGES = 3;
const INDEX_PAGES = 50;
const MAX_INDEX_CHARS = 2_000_000;

// Returns the extract plus the pages actually asked for, so the cost claim
// ("at most two extra pages") is checked rather than assumed.
async function walk(pages: string[]) {
  const read: number[] = [];
  const out = await collectPages(pages.length, async (i) => {
    read.push(i);
    return pages[i - 1];
  });
  return { ...out, read };
}

const huge = "x".repeat(MAX_INDEX_CHARS + 1);

describe("collectPages", () => {
  test("a normal article: matcher sees three pages, the index sees all of them", async () => {
    const out = await walk(["one", "two", "three", "four", "five"]);
    expect(out.matchText).toBe("one\ntwo\nthree");
    expect(out.fullText).toBe("one\ntwo\nthree\nfour\nfive");
    expect(out.pages).toBe(5);
    expect(out.truncated).toBe(false);
  });

  test("a first page over the char cap still yields the whole match slice", async () => {
    const out = await walk([huge, "PMID: 12345678", "page three", "page four"]);
    // The identifier on page 2 is the point: before this, the cap broke the
    // loop on page 1 and the import reported the file as unmatched.
    expect(out.matchText).toContain("PMID: 12345678");
    expect(out.matchText).toContain("page three");
    expect(out.matchText).not.toContain("page four");
    expect(out.pages).toBe(1); // only page 1 reached the index
    expect(out.truncated).toBe(true);
    expect(out.read).toEqual([1, 2, 3]); // and it stops as soon as the slice is full
  });

  test("the cap tripped after the match slice stops the read there", async () => {
    const out = await walk(["a", "b", "c", huge, "never read"]);
    expect(out.matchText).toBe("a\nb\nc");
    expect(out.pages).toBe(4);
    expect(out.fullText.length).toBe(MAX_INDEX_CHARS);
    expect(out.read).toEqual([1, 2, 3, 4]);
  });

  test("a document shorter than the match slice", async () => {
    const out = await walk(["only page"]);
    expect(out.matchText).toBe("only page");
    expect(out.fullText).toBe("only page");
    expect(out.pages).toBe(1);
    expect(out.truncated).toBe(false);
  });

  test("a long document is cut at the page cap and flagged", async () => {
    const pages = Array.from({ length: INDEX_PAGES + 10 }, (_, i) => `p${i + 1}`);
    const out = await walk(pages);
    expect(out.pages).toBe(INDEX_PAGES);
    expect(out.truncated).toBe(true);
    expect(out.read.length).toBe(INDEX_PAGES);
    expect(out.matchText).toBe("p1\np2\np3");
  });

  test("an empty document reads nothing", async () => {
    const out = await walk([]);
    expect(out.matchText).toBe("");
    expect(out.fullText).toBe("");
    expect(out.pages).toBe(0);
    expect(out.truncated).toBe(false);
    expect(out.read).toEqual([]);
  });
});
