// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { createSources, SourcesContext, useReloadToken, useSaved } from "./sources";
import { createTestApi } from "../test-api";
import type { PaperSource } from "../types";

// The store's own bookkeeping, against a library held in memory (test-api.ts).
// What a view does with what it holds is that view's test's.

afterEach(cleanup);

function setUp() {
  const server = createTestApi();
  return { server, sources: createSources(server.api) };
}

describe("reading the lists", () => {
  it("reads the topics, and says why when it can't", async () => {
    const { server, sources } = setUp();
    server.addTopic("Asthma");
    expect(await sources.loadTopics()).toHaveLength(1);

    server.addTopic("Gout");
    server.fail("getTopics", "Offline.");
    expect(await sources.loadTopics()).toBeNull();
    expect(sources.topics().map((t) => t.name)).toEqual(["Asthma"]);
    expect(sources.topicsError()).toBe("Offline.");

    server.recover("getTopics");
    await sources.loadTopics();
    expect(sources.topics()).toHaveLength(2);
    expect(sources.topicsError()).toBeNull();
  });

  it("keeps the folders and collections it had when they can't be read", async () => {
    const { server, sources } = setUp();
    server.addFolder("Reading");
    server.addCollection("Thesis");
    await Promise.all([sources.loadFolders(), sources.loadCollections()]);

    server.addFolder("Later");
    server.fail("getBookmarkFolders");
    server.fail("getCollections");
    expect(await sources.loadFolders()).toEqual([]);
    expect(await sources.loadCollections()).toEqual([]);
    expect(sources.folders().map((f) => f.name)).toEqual(["Reading"]);
    expect(sources.collections().map((c) => c.name)).toEqual(["Thesis"]);
  });

  it("files each bookmark under its paper", async () => {
    const { server, sources } = setUp();
    const reading = server.addFolder("Reading");
    const later = server.addFolder("Later");
    server.bookmark(reading, "1", "2");
    server.bookmark(later, "2");
    await sources.loadBookmarks();
    expect(sources.saved()).toEqual(new Map([["1", new Set([reading])], ["2", new Set([reading, later])]]));
  });

  it("keeps the saved map it had when the bookmarks can't be read", async () => {
    const { server, sources } = setUp();
    server.bookmark(server.addFolder("Reading"), "1");
    await sources.loadBookmarks();
    const before = sources.saved();
    server.fail("getBookmarks");
    await sources.loadBookmarks();
    expect(sources.saved()).toBe(before);
  });
});

describe("a bookmark toggle", () => {
  it("saves and unsaves a paper in the map, and forgets one saved nowhere", () => {
    const { sources } = setUp();
    sources.applySaved("1", (folders) => folders.add(7));
    sources.applySaved("1", (folders) => folders.add(8));
    expect(sources.saved().get("1")).toEqual(new Set([7, 8]));
    sources.applySaved("1", (folders) => folders.delete(7));
    sources.applySaved("1", (folders) => folders.delete(8));
    expect(sources.saved().has("1")).toBe(false);
  });

  // The views read the map through useSaved, which re-renders only for a
  // different value.
  it("replaces the map rather than changing the one it handed out", () => {
    const { sources } = setUp();
    const before = sources.saved();
    sources.applySaved("1", (folders) => folders.add(7));
    expect(sources.saved()).not.toBe(before);
    expect(before.size).toBe(0);
  });
});

describe("reload tokens", () => {
  const folder: PaperSource = { folder: 1 };
  const collection: PaperSource = { collection: 1 };
  const everyCollection: PaperSource = { allCollections: true };

  it("moves one source's token, and no other's", () => {
    const { sources } = setUp();
    sources.reloadSource(collection);
    expect(sources.tokenFor(collection)).toBe(1);
    // The same id, a different source.
    expect(sources.tokenFor(folder)).toBe(0);
    expect(sources.tokenFor(everyCollection)).toBe(0);
  });

  it("moves every source's token at once, those never moved before too", () => {
    const { sources } = setUp();
    sources.reloadSource(collection);
    sources.reloadEverything();
    expect(sources.tokenFor(collection)).toBe(2);
    expect(sources.tokenFor(folder)).toBe(1);
    expect(sources.tokenFor({ topic: 9 })).toBe(1);
  });
});

describe("the hooks", () => {
  function mount(read: () => unknown) {
    const { sources } = setUp();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SourcesContext.Provider value={sources}>{children}</SourcesContext.Provider>
    );
    let renders = 0;
    const view = renderHook(
      () => {
        renders++;
        return read();
      },
      { wrapper }
    );
    return { sources, view, renders: () => renders };
  }

  it("re-render a view when its own source's token moves, and not for another's", () => {
    const { sources, view, renders } = mount(() => useReloadToken({ folder: 1 }));
    const before = renders();
    act(() => sources.reloadSource({ folder: 2 }));
    expect(renders()).toBe(before);
    act(() => sources.reloadSource({ folder: 1 }));
    expect(view.result.current).toBe(1);
    expect(renders()).toBe(before + 1);
  });

  it("don't re-render the saved map's readers when only a token moves", () => {
    const { sources, renders } = mount(() => useSaved());
    const before = renders();
    act(() => sources.reloadSource({ folder: 1 }));
    expect(renders()).toBe(before);
  });
});
