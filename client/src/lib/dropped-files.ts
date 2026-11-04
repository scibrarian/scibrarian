// Files dragged onto the app from outside it: what a drop carried, the folders
// in it walked into one flat list of the files they hold, and the guard that
// stops a drop anywhere else from opening the file in place of the app.

// Whether a drag is carrying files from outside, rather than text or a link
// dragged within the page, which are left to do what they always do.
export function carriesFiles(dt: DataTransfer | null): boolean {
  return dt != null && Array.from(dt.types).includes("Files");
}

// A drop, taken apart while it can still be read: the files dropped as
// themselves, and the folders still to be walked.
export type Drop = { files: File[]; folders: FileSystemDirectoryEntry[] };

// Must run inside the drop event, before anything is awaited. The browser
// empties the DataTransfer once the event returns, so an item asked for after
// that has nothing in it: a reader that took the first entry and awaited before
// asking for the second would come back with one folder of the several dropped.
export function takeDrop(dt: DataTransfer): Drop {
  const files: File[] = [];
  const folders: FileSystemDirectoryEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) {
      folders.push(entry as FileSystemDirectoryEntry);
    } else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return { files, folders };
}

// The files in these folders and in every folder below them, as one list. A
// collection has no folders of its own, so the nesting has nowhere to go.
//
// Leaves out what the reader's file manager would have hidden: anything whose
// name starts with a dot, and the __MACOSX folder a zip made on a Mac unpacks
// to. Nobody put those there on purpose, and the AppleDouble files among them —
// a ._paper.pdf beside every paper.pdf — end in .pdf, so they would get past
// the PDF filter, be sent, and be turned away by the server one for one. Files
// dropped as themselves are never filtered like this: those were picked.
//
// Never rejects. A file or folder that can't be read is counted in
// `unreadable` and the walk goes on, so one locked folder doesn't cost the
// reader the papers around it.
export async function walkFolders(
  folders: FileSystemDirectoryEntry[]
): Promise<{ files: File[]; unreadable: number }> {
  const files: File[] = [];
  let unreadable = 0;
  const queue = [...folders];
  for (let folder = queue.shift(); folder; folder = queue.shift()) {
    let entries: FileSystemEntry[];
    try {
      entries = await readFolder(folder);
    } catch {
      unreadable++;
      continue;
    }
    const shown = entries.filter((e) => !hidden(e.name));
    for (const e of shown) if (e.isDirectory) queue.push(e as FileSystemDirectoryEntry);
    const read = await Promise.allSettled(
      shown.filter((e) => e.isFile).map((e) => fileOf(e as FileSystemFileEntry))
    );
    for (const r of read) {
      if (r.status === "fulfilled") files.push(r.value);
      else unreadable++;
    }
  }
  return { files, unreadable };
}

function hidden(name: string): boolean {
  return name.startsWith(".") || name === "__MACOSX";
}

// readEntries hands a folder over a batch at a time — at most 100 entries a
// call in Chromium — and says it has finished with an empty batch. One call
// reads a folder of 100 papers whole and a folder of 101 short, with nothing to
// say anything was left behind, so it is called until it comes back empty.
function readFolder(folder: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = folder.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

// Turn away files dropped anywhere that doesn't take them. Left alone, the
// browser treats such a drop as "open this file" and opens it in place of the
// app, so a PDF that missed its collection by an inch replaces the Library in
// the tab. (The desktop build never navigates there — main.mjs hands nothing
// but http(s) on — but the drop still vanishes without a sign.)
//
// A target that takes the drop has already said so by cancelling its
// dragover, which reaches the window after it, and is left alone. Everywhere
// else the cursor shows the refusal before the button is let go.
export function refuseStrayDrops(target: Window): () => void {
  const refuse = (e: DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "none";
  };
  target.addEventListener("dragover", refuse);
  target.addEventListener("drop", refuse);
  return () => {
    target.removeEventListener("dragover", refuse);
    target.removeEventListener("drop", refuse);
  };
}
