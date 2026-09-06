import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Pencil, Plus, Boxes } from "lucide-react";
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

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [switchingTo, setSwitchingTo] = useState<Workspace | null>(null);
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
      <DropdownMenu.Root>
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
          <DropdownMenu.Content className="picker-menu workspace-menu" align="start" sideOffset={6} loop>
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
                <button
                  type="button"
                  className="workspace-rename"
                  aria-label={`Rename ${w.name}`}
                  title="Rename"
                  onClick={(e) => {
                    // Both, and neither is redundant: stopPropagation keeps the
                    // click off the row's own handler, preventDefault keeps Radix
                    // from treating it as a selection and closing the menu out
                    // from under the dialog that is about to open.
                    e.stopPropagation();
                    e.preventDefault();
                    setRenaming(w);
                  }}
                >
                  <Pencil size={13} aria-hidden />
                </button>
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
        placeholder="Agency or client name"
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
        open={switchingTo != null}
        title={SWITCH_TITLE}
        message={
          `Scibrarian will close and reopen in “${switchingTo?.name}”. ` +
          "Each workspace is a separate library, so nothing moves between them."
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
