import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Pencil, Plus, Trash2, Boxes } from "lucide-react";
import { api } from "../api";
import { errorMessage } from "../lib/format";
import type { Workspace } from "../types";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import { MAX_NAME_CHARS } from "../../../shared/limits";

// Which library this window is looking at, and how to open a different one.
//
// A freelancer works for several agencies, and a workspace is a whole separate
// library — its own database, its own PDFs, its own pairing. That is a bigger
// thing than anything else in the header, which is why it sits in the brand
// rather than among the section controls: it names *what you are in*, where the
// rest of the bar names what you are looking at inside it.
//
// **It draws nothing unless there is something to draw.** The list is empty on
// every deployment that is not the desktop app, so a hosted instance renders no
// switcher and needs no flag saying it shouldn't — see api.getWorkspaces. One
// workspace still renders, because otherwise there is no way to make a second.

// Switching restarts the app, so the dialog says so. Not a confirmation of a
// dangerous act — nothing is lost — but of an interruption: the window closes
// and comes back, and a person who expected a tab-switch and got that would
// reasonably think something had crashed.
const SWITCH_TITLE = "Switch workspace";

/**
 * What deleting one would destroy, said out loud.
 *
 * Three wordings for three states, and that distinction is the whole point of
 * carrying the counts. A workspace with papers in it names them, because "4
 * stored PDFs" is what stops a wrong click long after "this cannot be undone"
 * has stopped being read. An empty one says so and reads as the small thing it
 * is. One whose counts are absent could not be measured — see the Workspace
 * type — so it claims nothing it cannot support and falls back to the shape of
 * the loss rather than its size.
 *
 * The whole sentence rather than a fragment the caller splices in: the three
 * states do not share a grammar, and the version that tried to ended up
 * promising to delete the stored PDFs twice.
 */
function deleteWarning(w: Workspace): string {
  // True of all three, and the part that actually needs saying: a workspace is
  // not a folder things can be moved out of first.
  const tail = "Nothing moves to another workspace, and this cannot be undone.";
  const rest = "its topics, its settings, and any organization pairing";
  if (w.collections == null || w.files == null) {
    return `This permanently deletes its whole library — every collection and every stored PDF, plus ${rest}. ${tail}`;
  }
  if (w.collections === 0 && w.files === 0) {
    return `This workspace is empty — no collections, no stored PDFs. Deleting it also removes ${rest}. ${tail}`;
  }
  const collections = `${w.collections} collection${w.collections === 1 ? "" : "s"}`;
  const files = `${w.files} stored PDF${w.files === 1 ? "" : "s"}`;
  return `This permanently deletes its whole library — ${collections} and ${files}, plus ${rest}. ${tail}`;
}

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [switchingTo, setSwitchingTo] = useState<Workspace | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  // The menu is controlled so a row action can close it. It cannot close
  // itself: the action buttons stop the click reaching the row, so Radix never
  // sees a selection — and an open menu paints crisp and undimmed above a
  // dialog's scrim, looking live while the scrim swallows every click on it.
  const [menuOpen, setMenuOpen] = useState(false);
  // Set once the switch is committed and the process is on its way out. The
  // window is about to disappear, so this is the last thing this component ever
  // renders — it exists so the seconds before that don't look like a dead click.
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One fetch at mount. Nothing else in the app changes this list, and the one
  // thing that would — switching — takes the whole page with it.
  useEffect(() => {
    let live = true;
    api
      .getWorkspaces()
      .then((r) => {
        if (live) setWorkspaces(r.workspaces);
      })
      // Silent: a build without workspaces answers with an empty list rather
      // than an error, so anything landing here is a genuine fault in a control
      // that is decoration on most deployments. Failing closed draws nothing,
      // which is what every non-desktop build draws anyway.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const active = workspaces.find((w) => w.active) ?? null;
  if (!active) return null;

  async function run(work: Promise<{ workspaces: Workspace[] }>): Promise<void> {
    try {
      setWorkspaces((await work).workspaces);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function commitSwitch(target: Workspace): Promise<void> {
    setSwitchingTo(null);
    setRestarting(true);
    try {
      const { restarting: willRestart } = await api.switchWorkspace(target.id);
      // Saved, but nothing here can restart the process — a browser pointed at
      // the desktop build's port. Say what actually happened rather than sitting
      // on a promise that will never be followed by a relaunch.
      if (!willRestart) {
        setRestarting(false);
        setError(`“${target.name}” will open the next time you start Scibrarian.`);
      }
    } catch (err) {
      setRestarting(false);
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger className="workspace-trigger" disabled={restarting}>
          <Boxes size={15} className="workspace-icon" aria-hidden />
          {/* The control's accessible name has to carry what the glyph says to
              everyone else: on its own, "Acme" beside a product title reads as
              part of the title rather than as a button that changes it. */}
          <span className="sr-only">Workspace: </span>
          <span className="workspace-current">{active.name}</span>
          <span className="picker-caret">
            <ChevronDown size={14} aria-hidden />
          </span>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="picker-menu workspace-menu"
            align="start"
            sideOffset={6}
            loop
            // Every row action opens a dialog, and on close Radix hands focus
            // back to the trigger — which lands *after* the dialog has taken it,
            // leaving a focus trap the keyboard is standing outside of. The
            // dialog does its own focus management; this only declines to fight
            // it. Nothing is lost for a menu dismissed with Escape, which the
            // dialog's own close then returns focus for.
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {workspaces.map((w) => (
              <DropdownMenu.Item
                key={w.id}
                className={`picker-option ${w.active ? "active" : ""}`}
                onSelect={() => {
                  // The active one is not a no-op click to swallow: renaming is
                  // reached from the pencil beside it, and selecting the row you
                  // are already in should close the menu and do nothing, which
                  // is what falling through to nothing does.
                  if (!w.active) setSwitchingTo(w);
                }}
              >
                <span className="picker-option-name">
                  {/* A tick on the current one rather than colour alone, for the
                      same reason the mode buttons carry aria-pressed: which
                      library you are in is state, and state drawn only in the
                      fill reaches only the people who can see it. */}
                  {w.active ? (
                    <Check size={14} className="inline-icon" aria-hidden />
                  ) : (
                    <span className="inline-icon-gap" aria-hidden />
                  )}{" "}
                  {w.name}
                  {w.active && <span className="sr-only">, current</span>}
                </span>
                {/* Rename is a button inside the row rather than a second menu
                    level: there are only ever a handful of workspaces, and a
                    submenu to reach one field is more chrome than the field. */}
                <span className="workspace-actions">
                  <button
                    type="button"
                    className="workspace-action"
                    aria-label={`Rename ${w.name}`}
                    title="Rename"
                    onClick={(e) => {
                      // stopPropagation keeps the click off the row's own
                      // handler, which would read it as picking this workspace
                      // and offer to switch to it instead. That is also why the
                      // menu has to be dismissed by hand here — see menuOpen.
                      e.stopPropagation();
                      setMenuOpen(false);
                      setRenaming(w);
                    }}
                  >
                    <Pencil size={13} aria-hidden />
                  </button>
                  {/* Absent on the active row rather than disabled there, because
                      a disabled control invites working out how to enable it and
                      there is no way: the workspace you are in cannot be deleted,
                      its database being open in this very process. The way to
                      delete Acme is to be somewhere else — which the row above
                      this one is how you do. Its absence is also what guarantees
                      the list can never empty. */}
                  {!w.active && (
                    <button
                      type="button"
                      className="workspace-action danger"
                      aria-label={`Delete ${w.name}`}
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpen(false);
                        setDeleting(w);
                      }}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  )}
                </span>
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="picker-sep" />
            <DropdownMenu.Item className="picker-add" onSelect={() => setCreating(true)}>
              <Plus size={16} aria-hidden /> New workspace
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Errors from this control render beside it rather than in the app's
          banner: the switcher is mounted in the brand, above everything the
          banner sits over, and a name clash belongs next to the box it came
          from. */}
      {error && (
        <span className="workspace-error" role="status">
          {error}
        </span>
      )}
      {restarting && (
        <span className="workspace-error" role="status">
          Switching…
        </span>
      )}

      <PromptDialog
        open={creating}
        title="New workspace"
        maxLength={MAX_NAME_CHARS}
        submitLabel="Create"
        onSubmit={(name) => {
          setCreating(false);
          void run(api.createWorkspace(name));
        }}
        onCancel={() => setCreating(false)}
      />

      <PromptDialog
        open={renaming != null}
        title="Rename workspace"
        initialValue={renaming?.name ?? ""}
        maxLength={MAX_NAME_CHARS}
        submitLabel="Rename"
        onSubmit={(name) => {
          const target = renaming;
          setRenaming(null);
          if (target) void run(api.renameWorkspace(target.id, name));
        }}
        onCancel={() => setRenaming(null)}
      />

      <ConfirmDialog
        open={deleting != null}
        title={deleting ? `Delete “${deleting.name}”?` : ""}
        message={deleting ? deleteWarning(deleting) : ""}
        confirmLabel="Delete workspace"
        danger
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void run(api.deleteWorkspace(target.id));
        }}
        onCancel={() => setDeleting(null)}
      />

      <ConfirmDialog
        open={switchingTo != null}
        title={SWITCH_TITLE}
        message={
          `Scibrarian will close and reopen in “${switchingTo?.name}”. ` +
          "Each workspace uses its own data, so nothing moves between them."
        }
        confirmLabel="Switch and restart"
        onConfirm={() => {
          if (switchingTo) void commitSwitch(switchingTo);
        }}
        onCancel={() => setSwitchingTo(null)}
      />
    </>
  );
}
