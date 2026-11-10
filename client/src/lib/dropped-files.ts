// Files dragged onto the app from outside it: what a drop carried, the folders
// in it walked into one flat list of the files they hold, and the guard that
// stops a drop anywhere else from opening the file in place of the app.

// Whether a drag is carrying files from outside, rather than text, a link or
// an image dragged within the page, which are left to do what they always do.
//
// The types alone can't say so: Chromium lists "Files" among them for an image
// dragged within the page as well. Where the drag began can (see
// watchPageDrags).
export function carriesFiles(dt: DataTransfer | null): boolean {
  return dt != null && !dragFromPage && Array.from(dt.types).includes("Files");
}

// A drag that began inside the page, from its dragstart until it is over. Files
// dragged in from the desktop never fire dragstart here.
let dragFromPage = false;

// Keep dragFromPage. Cleared at the drop as well as at the dragend, because the
// dragend goes to the element the drag began on, and one taken out of the page
// mid-drag never passes it on to the window: missed, every file dragged in
// after it would be turned away. After the drop rather than during it, so that
// everything handling that drop still sees where it came from.
export function watchPageDrags(target: Window): () => void {
  const start = (e: Event) => {
    if (!e.defaultPrevented) dragFromPage = true;
  };
  const end = () => {
    dragFromPage = false;
  };
  const dropped = () => setTimeout(end);
  target.addEventListener("dragstart", start);
  target.addEventListener("dragend", end);
  target.addEventListener("drop", dropped);
  return () => {
    target.removeEventListener("dragstart", start);
    target.removeEventListener("dragend", end);
    target.removeEventListener("drop", dropped);
    end();
  };
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

// What a walk left out of its list, to be owned up to: files it didn't want,
// and files and folders it couldn't read.
export type PassedOver = { ignored: number; unreadable: number };

// How far a walk has got: the folders it has read, and the wanted files it has
// found in them.
export type WalkProgress = { folders: number; found: number };

// The files wanted from these folders and from every folder below them, as one
// list. A collection has no folders of its own, so the nesting has nowhere to
// go.
//
// Leaves out what the reader's file manager would have hidden: anything whose
// name starts with a dot, and the __MACOSX folder a zip made on a Mac unpacks
// to. Nobody put those there on purpose, and the AppleDouble files among them —
// a ._paper.pdf beside every paper.pdf — end in .pdf, so they would get past
// the PDF filter, be sent, and be turned away by the server one for one. Files
// dropped as themselves are never filtered like this: those were picked.
//
// What is wanted is told by name, before anything is opened, and the rest are
// only counted, in `ignored`. A Downloads folder of 8,000 images and 40 papers
// is read as 40 files, and a locked one among the images is a file that wasn't
// wanted, not one that couldn't be read.
//
// Never rejects, but for being stopped. A file or folder that can't be read is
// counted in `unreadable` and the walk goes on, so one locked folder doesn't
// cost the reader the papers around it.
//
// A folder dropped by mistake can be a whole disk, and nothing says how big a
// folder is until all of it has been read, so the walk can be watched and
// stopped. `onProgress` is told how far it has got after every folder read.
// Stopped by `signal`, it rejects with the signal's reason at once, even while
// it waits on a folder the browser never answers for.
export async function walkFolders(
  folders: FileSystemDirectoryEntry[],
  wanted: (file: { name: string }) => boolean,
  { signal, onProgress }: { signal?: AbortSignal; onProgress?: (progress: WalkProgress) => void } = {}
): Promise<{ files: File[] } & PassedOver> {
  const files: File[] = [];
  let ignored = 0;
  let unreadable = 0;
  let read = 0;
  const queue = [...folders];
  for (let folder = queue.shift(); folder; folder = queue.shift()) {
    let entries: FileSystemEntry[];
    try {
      entries = await unlessStopped(readFolder(folder), signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      unreadable++;
      continue;
    }
    const shown = entries.filter((e) => !hidden(e.name));
    for (const e of shown) if (e.isDirectory) queue.push(e as FileSystemDirectoryEntry);
    const inFolder = shown.filter((e) => e.isFile);
    const kept = inFolder.filter(wanted);
    ignored += inFolder.length - kept.length;
    const opened = await unlessStopped(
      Promise.allSettled(kept.map((e) => fileOf(e as FileSystemFileEntry))),
      signal
    );
    for (const r of opened) {
      if (r.status === "fulfilled") files.push(r.value);
      else unreadable++;
    }
    onProgress?.({ folders: ++read, found: files.length });
  }
  return { files, ignored, unreadable };
}

// `work`, unless `signal` stops it first, and then the signal's reason at once.
// The work itself goes on, since nothing takes back a readEntries already asked
// for, but nothing waits on it any more.
function unlessStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
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
        // An entry at a time, not push(...batch). Spread, a batch becomes that
        // many arguments, and an engine that hands a whole folder over in one
        // batch overflows the call on a big enough one. Thrown in here, it
        // would reach neither resolve nor reject, and the walk would wait on
        // this folder for ever.
        for (const entry of batch) all.push(entry);
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
