// @vitest-environment jsdom
import { Profiler } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BookmarkMenu } from "./BookmarkMenu";
import { createSources, SourcesContext } from "../lib/sources";
import { createTestApi } from "../test-api";

// The per-paper bookmark menu, over a library held in memory (test-api.ts):
// what it lists once it is opened, and what a closed one costs. There is one on
// every row on screen, so a closed menu re-rendering whenever the folders are
// read again is hundreds of rows re-rendering.

afterEach(cleanup);

const SAVED = "11111111";
const UNSAVED = "22222222";

// A menu for each paper, the first saved in "Reading", and a count of the
// commits under them.
async function menus() {
  const server = createTestApi();
  const reading = server.addFolder("Reading");
  server.addFolder("Later");
  server.bookmark(reading, SAVED);
  const sources = createSources(server.api);
  await Promise.all([sources.loadFolders(), sources.loadBookmarks()]);
  const commits = { count: 0 };
  render(
    <SourcesContext.Provider value={sources}>
      <Profiler id="menus" onRender={() => commits.count++}>
        {[SAVED, UNSAVED].map((pmid) => (
          <BookmarkMenu key={pmid} pmid={pmid} onError={() => {}} onNewFolder={() => {}} />
        ))}
      </Profiler>
    </SourcesContext.Provider>
  );
  return { server, sources, commits };
}

function open(label: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: label }),
    new MouseEvent("pointerdown", { bubbles: true })
  );
  return screen.getByRole("menu");
}

describe("the bookmark menu", () => {
  it("lists every folder once opened, checking the ones the paper is in", async () => {
    await menus();
    const menu = open("Saved in 1 folder");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Reading" }).getAttribute("aria-checked")).toBe(
      "true"
    );
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Later" }).getAttribute("aria-checked")).toBe(
      "false"
    );
  });

  it("lists a folder made while it is open", async () => {
    const { server, sources } = await menus();
    const menu = open("Save to a bookmark folder");
    await act(async () => {
      server.addFolder("Grants");
      await sources.loadFolders();
    });
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Grants" })).toBeTruthy();
  });

  it("leaves closed menus alone when the folders are read again", async () => {
    const { server, sources, commits } = await menus();
    const before = commits.count;
    await act(async () => {
      server.addFolder("Grants");
      await sources.loadFolders();
    });
    expect(commits.count).toBe(before);
  });
});
