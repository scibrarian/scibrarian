import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bookmark, ChevronDown, Plus } from "lucide-react";
import { errorMessage } from "../lib/format";
import type { Bookmarking } from "../lib/bookmarking";
import { ConfirmDialog, PromptDialog } from "./Dialogs";

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
  bookmarking,
  onError,
  onDone,
}: {
  pmids: string[];
  bookmarking: Bookmarking;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const count = pmids.length;
  const papers = `${count.toLocaleString()} paper${count === 1 ? "" : "s"}`;

  if (count === 0) return null;

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

        <DropdownMenu.Portal>
          <DropdownMenu.Content className="bookmark-menu" align="end" sideOffset={4} loop>
            {bookmarking.folders.map((f) => (
              <DropdownMenu.Item
                key={f.id}
                className="bookmark-option"
                onSelect={() => setTarget({ kind: "existing", id: f.id, name: f.name })}
              >
                <span className="bookmark-name">{f.name}</span>
                <span className="count">{f.paperCount}</span>
              </DropdownMenu.Item>
            ))}
            {bookmarking.folders.length === 0 && (
              <div className="bookmark-empty">No folders yet.</div>
            )}
            <DropdownMenu.Item className="bookmark-add" onSelect={() => setNaming(true)}>
              <Plus size={14} aria-hidden /> New folder…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <PromptDialog
        open={naming}
        title="New folder"
        placeholder="Folder name"
        submitLabel="Continue"
        onSubmit={(name) => {
          setNaming(false);
          setTarget({ kind: "new", name });
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
