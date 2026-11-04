// Stand-ins for what a drop from the desktop carries, which jsdom has none of:
// DataTransfer, and the file system entries behind its items. Shared by the
// tests of dropped-files and of the collection view that takes the drops.

export const pdf = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });

export function fileEntry(name: string, { unreadable = false } = {}): FileSystemFileEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (ok: (f: File) => void, fail?: (e: DOMException) => void) =>
      unreadable ? fail?.(new DOMException("Can't read it", "NotReadableError")) : ok(pdf(name)),
  } as unknown as FileSystemFileEntry;
}

// A folder that hands its entries over `batch` at a time, a tick apart, the
// way Chromium's does (100 a call), and ends with an empty batch.
export function folderEntry(
  name: string,
  children: FileSystemEntry[],
  { batch = 100, unreadable = false } = {}
): FileSystemDirectoryEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (ok: (b: FileSystemEntry[]) => void, fail?: (e: DOMException) => void) =>
          setTimeout(() => {
            if (unreadable) return fail?.(new DOMException("Can't read it", "NotReadableError"));
            const next = children.slice(at, at + batch);
            at += next.length;
            ok(next);
          }),
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

// What a drop event carries for these entries, dropped together.
export function dataTransfer(entries: FileSystemEntry[]): DataTransfer {
  return {
    types: ["Files"],
    dropEffect: "none",
    items: entries.map((e) => ({
      kind: "file",
      webkitGetAsEntry: () => e,
      getAsFile: () => (e.isFile ? pdf(e.name) : null),
    })),
  } as unknown as DataTransfer;
}
