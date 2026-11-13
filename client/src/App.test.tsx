// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { createSources, SourcesContext, type Sources } from "./lib/sources";
import { createTestApi } from "./test-api";

// The shell, over a library held in memory (test-api.ts): which source each
// section opens on, and where the reader is left when the list under a
// selection changes. What each view does with its source is that view's
// test's.

const served = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  // Methods asked for that test-api.ts doesn't answer, which hang rather than
  // fail so the view asking isn't sent down its error path instead.
  unanswered: [] as string[],
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
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
  vi.stubGlobal("__APP_VERSION__", "test");
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })
  );
  // jsdom has no layout, and App scrolls to the top on a change of source.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(served.unanswered).toEqual([]);
});

async function boot() {
  sources = createSources(server.api);
  render(
    <SourcesContext.Provider value={sources}>
      <App />
    </SourcesContext.Provider>
  );
  await waitFor(() => expect(document.querySelector("button.picker-trigger")).not.toBeNull());
}

// The name on the section's picker: what is selected there.
const picked = () => document.querySelector(".picker-current")?.textContent;
// What the page says in place of a source, when it has none to show.
const noSource = () => document.querySelector("main > .empty")?.textContent ?? null;

function section(name: "Library" | "Interests" | "Bookmarks") {
  fireEvent.click(screen.getByRole("button", { name }));
}

async function confirmDelete(button: string) {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
}

describe("where each section opens", () => {
  it("lands in the Library on its first collection, and every other section on its first entry", async () => {
    server.addTopic("Asthma");
    server.addTopic("Gout");
    server.addFolder("Reading");
    server.addFolder("Later");
    server.addCollection("Thesis");
    server.addCollection("Grants");
    await boot();
    expect(picked()).toBe("Thesis");
    section("Interests");
    expect(picked()).toBe("Asthma");
    section("Bookmarks");
    expect(picked()).toBe("Reading");
  });

  it("says a section is empty only when it is", async () => {
    await boot();
    expect(noSource()).toMatch(/^No collections yet/);
    section("Bookmarks");
    expect(noSource()).toMatch(/^No bookmark folders yet/);
  });
});

describe("when the list under a selection changes", () => {
  it("leaves a deleted folder for the first one left", async () => {
    server.addFolder("Reading");
    server.addFolder("Later");
    await boot();
    section("Bookmarks");
    await confirmDelete("Delete folder");
    await waitFor(() => expect(picked()).toBe("Later"));
  });

  it("leaves the Library empty once its last collection is deleted", async () => {
    server.addCollection("Thesis");
    await boot();
    await confirmDelete("Delete collection");
    await waitFor(() => expect(noSource()).toMatch(/^No collections yet/));
  });

  // A selection the list no longer has used to stay selected, and the section
  // said it had none at all.
  it("gives way to the first folder left when the one on screen goes elsewhere", async () => {
    const reading = server.addFolder("Reading");
    server.addFolder("Later");
    await boot();
    section("Bookmarks");
    await act(async () => {
      server.library.folders = server.library.folders.filter((f) => f.id !== reading);
      await sources.loadFolders();
    });
    expect(picked()).toBe("Later");
    expect(noSource()).toBeNull();
  });

  it("gives way to the first collection left when the one on screen goes elsewhere", async () => {
    const thesis = server.addCollection("Thesis");
    server.addCollection("Grants");
    await boot();
    await act(async () => {
      server.library.collections = server.library.collections.filter((c) => c.id !== thesis);
      await sources.loadCollections();
    });
    expect(picked()).toBe("Grants");
  });

  it("selects the first topic once there is one", async () => {
    await boot();
    section("Interests");
    expect(noSource()).toMatch(/^No topics yet/);
    await act(async () => {
      server.addTopic("Asthma");
      await sources.loadTopics();
    });
    expect(picked()).toBe("Asthma");
    expect(noSource()).toBeNull();
  });

  it("keeps every collection at once selected only while there are any", async () => {
    server.addCollection("Thesis");
    await boot();
    fireEvent.pointerDown(
      document.querySelector("button.picker-trigger")!,
      new MouseEvent("pointerdown", { bubbles: true })
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /All collections/ }));
    expect(picked()).toBe("All collections");
    await act(async () => {
      server.library.collections = [];
      await sources.loadCollections();
    });
    expect(noSource()).toMatch(/^No collections yet/);
  });

  it("forgets what was selected when the library is emptied", async () => {
    server.addCollection("Thesis");
    await boot();
    await act(async () => {
      server.library.collections = [];
      await sources.loadCollections();
    });
    expect(noSource()).toMatch(/^No collections yet/);
    await act(async () => {
      server.addCollection("Grants");
      await sources.loadCollections();
    });
    expect(picked()).toBe("Grants");
  });
});
