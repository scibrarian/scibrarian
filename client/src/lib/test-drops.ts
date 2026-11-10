// Stand-ins for what a drop from the desktop carries, which jsdom has none of:
// DataTransfer, and the file system entries behind its items. Shared by the
// tests of dropped-files and of the collection view that takes the drops.

export const pdf = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });

// `size` is what the file says it holds, without its holding it: enough to put
// it over the upload cap.
export function fileEntry(
  name: string,
  { unreadable = false, size }: { unreadable?: boolean; size?: number } = {}
): FileSystemFileEntry {
  const file = () => {
    const f = pdf(name);
    if (size != null) Object.defineProperty(f, "size", { value: size });
    return f;
  };
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (ok: (f: File) => void, fail?: (e: DOMException) => void) =>
      unreadable ? fail?.(new DOMException("Can't read it", "NotReadableError")) : ok(file()),
  } as unknown as FileSystemFileEntry;
}

// A folder that hands its entries over `batch` at a time, a tick apart, the
// way Chromium's does (100 a call), and ends with an empty batch. A `stuck` one
// is asked and never answers.
export function folderEntry(
  name: string,
  children: FileSystemEntry[],
  { batch = 100, unreadable = false, stuck = false } = {}
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
            if (stuck) return;
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
