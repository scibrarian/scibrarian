import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bookmark, ChevronDown } from "lucide-react";
import { errorMessage } from "../lib/format";
import type { Bookmarking } from "../lib/bookmarking";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import { FolderMenuContent } from "./FolderMenu";
import { MAX_BULK_BOOKMARK_PMIDS, MAX_NAME_CHARS } from "../../../shared/limits";

// Where a folder for a bulk save comes from: one that already exists, or one
// named in the prompt and created on confirm. Held rather than acted on
// immediately so the confirmation can name it.
type Target = { kind: "existing"; id: number; name: string } | { kind: "new"; name: string };

// "Save N papers" — the bulk counterpart to the per-paper BookmarkMenu. It
// lives in the filter row because that row is the only chrome all three views
// share, and because the set it acts on is precisely what the controls beside
// it just narrowed.
//
// The count is on the trigger, not hidden behind it: with a few weak filters
// this is thousands of papers, and "every currently visible paper" is not a
// number anyone can estimate from a screenful of rows. `pmids` is the whole
// filtered set, never the lazily-rendered chunk on screen.
export function SaveAllButton({
  pmids,
  total,
  bookmarking,
  onError,
  onDone,
}: {
  pmids: string[];
  // The same list before the filters ran. Only read when `pmids` is empty, to
  // tell the two reasons for that apart — see below.
  total: number;
  bookmarking: Bookmarking;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const count = pmids.length;
  const papers = `${count.toLocaleString()} paper${count === 1 ? "" : "s"}`;

  // Nothing to save. Two reasons, wanting opposite things.
  //
  // The filters narrowed the list to nothing: the row around this button is full
  // of the controls that did the narrowing, and it wraps — unmounting here and
  // remounting when they widen again pulls the row between one line and two and
  // walks every paper below it up and down. So the slot stays.
  //
  // Or the source is empty, and there are no such controls to hold a line: a
  // source with no papers has no journals, no citation range and no year span,
  // so the row is this button and nothing else. A slot held open there is a
  // blank band above the empty state with nothing in it to explain it, and it
  // is the *first* thing you see in a folder you just made.
  if (count === 0) {
    if (total === 0) return null;

    // A disabled button holding the trigger's own children, not an empty span:
    // measured both ways, an empty inline-flex collapses to its padding (7px
    // short) and a filled <span> picks up the body's line-height where a
    // <button> takes the UA's (4.5px tall). Only the same element with the same
    // content measures the same, and it holds if the padding or font changes.
    return (
      <button className="save-all-btn save-all-empty" disabled aria-hidden="true">
        <Bookmark size={14} aria-hidden />
        Save
        <ChevronDown size={14} aria-hidden />
      </button>
    );
  }

  // The size of the set is known before anything is sent, so a save the server
  // would refuse is reported here — and reported instead of the confirmation,
  // which would otherwise promise to save a number that can't be saved.
  function choose(to: Target) {
    if (count > MAX_BULK_BOOKMARK_PMIDS) {
      onError(
        `A single save is limited to ${MAX_BULK_BOOKMARK_PMIDS.toLocaleString()} papers, ` +
          `and ${papers} match. Narrow the filters and save again.`
      );
      return;
    }
    setTarget(to);
  }

  async function save(to: Target) {
    setTarget(null);
    setBusy(true);
    try {
      const folder =
        to.kind === "new" ? await bookmarking.createFolder(to.name) : { id: to.id, name: to.name };
      const { added, alreadySaved } = await bookmarking.addMany(folder.id, pmids);
      // Report what actually landed rather than the number asked for — with
      // overlapping saves those differ, and claiming the larger figure would
      // misrepresent what's in the folder.
      onDone(
        `Saved ${added.toLocaleString()} paper${added === 1 ? "" : "s"} to “${folder.name}”.` +
          (alreadySaved > 0 ? ` ${alreadySaved.toLocaleString()} were already there.` : "")
      );
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="save-all-btn" disabled={busy}>
          <Bookmark size={14} aria-hidden />
          {busy ? "Saving…" : `Save ${papers}`}
          <ChevronDown size={14} aria-hidden />
        </DropdownMenu.Trigger>

        <FolderMenuContent
          folders={bookmarking.folders}
          onNewFolder={() => setNaming(true)}
          renderFolder={(f) => (
            <DropdownMenu.Item
              key={f.id}
              className="bookmark-option"
              onSelect={() => choose({ kind: "existing", id: f.id, name: f.name })}
            >
              <span className="bookmark-name">{f.name}</span>
              <span className="count">{f.paperCount}</span>
            </DropdownMenu.Item>
          )}
        />
      </DropdownMenu.Root>

      <PromptDialog
        open={naming}
        title="New folder"
        placeholder="Folder name"
        maxLength={MAX_NAME_CHARS}
        submitLabel="Continue"
        onSubmit={(name) => {
          setNaming(false);
          choose({ kind: "new", name });
        }}
        onCancel={() => setNaming(false)}
      />

      {/* Confirmed even for a folder being created here: the point of the step
          is that the count is large and easy to misjudge, and there is no bulk
          un-save to undo it with. */}
      <ConfirmDialog
        open={target != null}
        title={`Save ${papers}?`}
        message={
          target
            ? `${papers} matching the current filters will be saved to “${target.name}”.` +
              (target.kind === "existing"
                ? " Papers already in the folder stay as they are."
                : " The folder will be created.")
            : ""
        }
        confirmLabel="Save"
        onConfirm={() => target && void save(target)}
        onCancel={() => setTarget(null)}
      />
    </>
  );
}
