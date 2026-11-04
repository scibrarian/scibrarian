// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { refuseStrayDrops, takeDrop, walkFolders } from "./dropped-files";
import { dataTransfer, fileEntry, folderEntry } from "./test-drops";

const names = (files: File[]) => files.map((f) => f.name).sort();

describe("taking a drop apart", () => {
  it("separates the files dropped as themselves from the folders to walk", () => {
    const folder = folderEntry("Downloads", []);
    const dropped = takeDrop(dataTransfer([fileEntry("a.pdf"), folder, fileEntry("b.pdf")]));
    expect(names(dropped.files)).toEqual(["a.pdf", "b.pdf"]);
    expect(dropped.folders).toEqual([folder]);
  });

  it("keeps a hidden file that was dropped as itself, since it was picked", () => {
    const dropped = takeDrop(dataTransfer([fileEntry(".draft.pdf")]));
    expect(names(dropped.files)).toEqual([".draft.pdf"]);
  });
});

describe("walking dropped folders", () => {
  it("flattens every folder below into one list", async () => {
    const tree = folderEntry("Cardiology", [
      fileEntry("a.pdf"),
      folderEntry("2024", [fileEntry("b.pdf"), folderEntry("trials", [fileEntry("c.pdf")])]),
      folderEntry("empty", []),
    ]);
    const found = await walkFolders([tree, folderEntry("Other", [fileEntry("d.pdf")])]);
    expect(names(found.files)).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
    expect(found.unreadable).toBe(0);
  });

  it("reads a folder past the first batch of entries it hands over", async () => {
    const many = Array.from({ length: 250 }, (_, i) => fileEntry(`paper-${i}.pdf`));
    const found = await walkFolders([folderEntry("Big", many, { batch: 100 })]);
    expect(found.files).toHaveLength(250);
  });

  it("leaves out what a file manager hides: dotfiles, dot folders and __MACOSX", async () => {
    const tree = folderEntry("Unzipped", [
      fileEntry("paper.pdf"),
      fileEntry("._paper.pdf"),
      fileEntry(".DS_Store"),
      folderEntry(".git", [fileEntry("tracked.pdf")]),
      folderEntry("__MACOSX", [fileEntry("._paper.pdf"), fileEntry("paper.pdf")]),
    ]);
    const found = await walkFolders([tree]);
    expect(names(found.files)).toEqual(["paper.pdf"]);
  });

  it("counts what it couldn't read and keeps the rest", async () => {
    const tree = folderEntry("Mixed", [
      fileEntry("a.pdf"),
      fileEntry("locked.pdf", { unreadable: true }),
      folderEntry("private", [fileEntry("b.pdf")], { unreadable: true }),
      folderEntry("open", [fileEntry("c.pdf")]),
    ]);
    const found = await walkFolders([tree]);
    expect(names(found.files)).toEqual(["a.pdf", "c.pdf"]);
    expect(found.unreadable).toBe(2);
  });
});

describe("files dropped where nothing takes them", () => {
  let stop = () => {};
  afterEach(() => stop());

  function dragOver(target: EventTarget, types: string[]) {
    const dt = { types, dropEffect: "copy" };
    const e = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: dt });
    target.dispatchEvent(e);
    return { prevented: e.defaultPrevented, dropEffect: dt.dropEffect };
  }

  it("are turned away, so the browser doesn't open them in place of the app", () => {
    stop = refuseStrayDrops(window);
    expect(dragOver(document.body, ["Files"])).toEqual({ prevented: true, dropEffect: "none" });
  });

  it("are left to a target that has taken them", () => {
    stop = refuseStrayDrops(window);
    const target = document.body.appendChild(document.createElement("div"));
    target.addEventListener("dragover", (e) => e.preventDefault());
    expect(dragOver(target, ["Files"])).toEqual({ prevented: true, dropEffect: "copy" });
    target.remove();
  });

  it("don't include text or links dragged within the page", () => {
    stop = refuseStrayDrops(window);
    expect(dragOver(document.body, ["text/plain"])).toEqual({ prevented: false, dropEffect: "copy" });
  });
});
