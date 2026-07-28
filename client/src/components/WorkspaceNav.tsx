import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Search, Library, Bookmark, ChevronDown, Plus, Folder } from "lucide-react";
import { api } from "../api";
import type { BookmarkFolder, Collection, Topic } from "../types";
import { ShareLinkButton } from "./ShareLinkButton";
import { SkeletonBar } from "./Skeleton";

export type Mode = "interests" | "bookmarks" | "papers";

// One entry in the picker, normalized across the three workspaces so the menu
// renders from a single loop.
interface PickerItem {
  id: number;
  name: string;
  count: number;
}

// How each workspace is named and drawn, and the only place that decides it:
// the mode switch renders all three, the picker trigger looks up the active
// one, and App's empty states name workspaces in prose. Separate literals would
// let them drift onto different icons for the same workspace.
//
// Keyed by Mode rather than a list of them so adding a fourth workspace without
// describing it here is a type error instead of an undefined at render. Module
// scope because it never varies — this component re-renders on every id, banner
// and refresh change, and rebuilding a constant each time is waste.
export const MODES: Record<Mode, { label: string; icon: typeof Search }> = {
  interests: { label: "Interests", icon: Search },
  bookmarks: { label: "Bookmarks", icon: Bookmark },
  papers: { label: "Library", icon: Library },
};

// Nav order, which is the literal's own: Object.entries preserves insertion
// order for string keys, so the switch stays in step with MODES for free rather
// than repeating the three names in a second list that could fall behind.
const MODE_ORDER = Object.entries(MODES) as [Mode, (typeof MODES)[Mode]][];

// Two-part navigation: an Interests / Bookmarks / Library mode switch, plus a
// dropdown that picks the active topic (MeSH search), bookmark folder, or
// collection within that mode. The dropdown replaces per-item tabs so a long
// list never clutters the header. Radix DropdownMenu owns the open state and
// supplies outside-click/Escape dismissal, arrow-key navigation, and focus
// return.
export function WorkspaceNav({
  mode,
  isAdmin,
  onModeChange,
  topics,
  folders,
  collections,
  activeTopicId,
  activeFolderId,
  activeCollectionId,
  settingsActive,
  loaded,
  tokenRequired,
  onSelectTopic,
  onSelectFolder,
  onSelectCollection,
  onCreateFolder,
  onCreateCollection,
  onAddTopic,
  onShareError,
}: {
  mode: Mode;
  isAdmin: boolean;
  onModeChange: (m: Mode) => void;
  topics: Topic[];
  folders: BookmarkFolder[];
  collections: Collection[];
  activeTopicId: number | null;
  activeFolderId: number | null;
  activeCollectionId: number | null;
  settingsActive: boolean;
  loaded: boolean;
  tokenRequired: boolean;
  onSelectTopic: (id: number) => void;
  onSelectFolder: (id: number) => void;
  onSelectCollection: (id: number) => void;
  onCreateFolder: () => void;
  onCreateCollection: () => void;
  onAddTopic: () => void;
  onShareError: (message: string) => void;
}) {
  const activeCollection = collections.find((c) => c.id === activeCollectionId);

  // Every mode's picker is the same thing — a named list with count badges and
  // an admin-only "add" row — so each is described here and rendered by one
  // block below. Three hand-written arms would be three places for the markup
  // to drift.
  //
  // Chosen before it's built, not built and then subscripted: this component
  // re-renders on every change to the active ids, the status banner and the
  // refreshing flag, and describing all three arms up front re-mapped every
  // topic, folder and collection each time to throw two of the lists away.
  const picker =
    mode === "interests"
      ? {
          items: topics.map((d) => ({ id: d.id, name: d.name, count: d.articleCount ?? 0 })),
          activeId: activeTopicId,
          onSelect: onSelectTopic,
          folderIcon: false,
          empty: "No topics yet.",
          placeholder: topics.length ? "Select a topic" : "No topics yet",
          addLabel: "Add topic…",
          onAdd: onAddTopic,
        }
      : mode === "bookmarks"
        ? {
            items: folders.map((f) => ({ id: f.id, name: f.name, count: f.paperCount })),
            activeId: activeFolderId,
            onSelect: onSelectFolder,
            folderIcon: true,
            empty: "No folders yet.",
            placeholder: folders.length ? "Select a folder" : "No folders yet",
            addLabel: "New folder",
            onAdd: onCreateFolder,
          }
        : {
            items: collections.map((c) => ({ id: c.id, name: c.name, count: c.matchedCount })),
            activeId: activeCollectionId,
            onSelect: onSelectCollection,
            folderIcon: true,
            empty: "No collections yet.",
            placeholder: collections.length ? "Select a collection" : "No collections yet",
            addLabel: "New collection",
            onAdd: onCreateCollection,
          };

  const active: PickerItem | undefined = picker.items.find((i) => i.id === picker.activeId);
  const label = active?.name ?? picker.placeholder;
  const activeMode = MODES[mode];
  const ModeIcon = activeMode.icon;

  return (
    <nav className="workspace-nav">
      <div className="mode-switch" role="group" aria-label="Workspace">
        {/* aria-pressed, not just the class: which workspace you're in is state,
            and drawn on its own it reaches only the people who can see the fill.
            Same condition as the class so the two can't disagree — under
            Settings none of them is pressed, because none of them is current. */}
        {MODE_ORDER.map(([value, m]) => (
          <button
            key={value}
            className={mode === value && !settingsActive ? "active" : ""}
            aria-pressed={mode === value && !settingsActive}
            onClick={() => onModeChange(value)}
          >
            <m.icon size={16} aria-hidden /> {m.label}
          </button>
        ))}
      </div>

      <div className="ws-picker">
        {/* Until the first load resolves we don't yet know if there are any
            topics/folders/collections, so show a placeholder rather than
            flashing the "No topics yet" empty state. */}
        {!loaded ? (
          <div className="ws-trigger ws-trigger-loading" aria-hidden="true">
            {/* Stands in for the mode icon. Without it the trigger gains the
                icon's 16px and the row's 8px gap on the handoff, widening
                itself and shoving the share button along beside it. */}
            <SkeletonBar w={16} h={16} />
            <SkeletonBar w={128} h={14} />
          </div>
        ) : (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="ws-trigger">
              {/* Which workspace this name belongs to. A topic, a bookmark
                  folder and a collection can all be called "Cardiac Imaging",
                  and the trigger is the part of the nav that changes — without
                  the icon the three render identically. The label carries the
                  same thing for a screen reader, which gets nothing from the
                  icon: the trigger's name reads "Interests, Cardiac Imaging,
                  240", so it stands apart from its namesakes when read on its
                  own, away from the pressed button in the switch. */}
              <ModeIcon size={16} className="ws-mode-icon" aria-hidden />
              <span className="sr-only">{activeMode.label}</span>
              <span className="ws-current">{label}</span>
              {active && <span className="count">{active.count}</span>}
              <span className="ws-caret"><ChevronDown size={16} aria-hidden /></span>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content className="ws-menu" align="start" sideOffset={6} loop>
                {picker.items.map((item) => (
                  <DropdownMenu.Item
                    key={item.id}
                    className={`ws-option ${item.id === picker.activeId && !settingsActive ? "active" : ""}`}
                    onSelect={() => picker.onSelect(item.id)}
                  >
                    <span className="ws-option-name">
                      {picker.folderIcon && <Folder size={14} className="inline-icon" aria-hidden />}{" "}
                      {item.name}
                    </span>
                    <span className="count">{item.count}</span>
                  </DropdownMenu.Item>
                ))}
                {picker.items.length === 0 && <div className="ws-empty">{picker.empty}</div>}
                {isAdmin && (
                  <DropdownMenu.Item className="ws-add" onSelect={picker.onAdd}>
                    <Plus size={16} aria-hidden /> {picker.addLabel}
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        {/* Owner-only: copy an expiring link that downloads the active
            collection as a zip. Beside the picker so it's unambiguous what
            gets shared. */}
        {loaded &&
          mode === "papers" &&
          !settingsActive &&
          isAdmin &&
          tokenRequired &&
          activeCollection &&
          activeCollection.fileCount > 0 && (
            <ShareLinkButton
              mint={() => api.mintCollectionShareLink(activeCollection.id)}
              title={`Copy a link that downloads “${activeCollection.name}” as a zip (valid 24 hours)`}
              ariaLabel="Copy collection share link"
              onError={onShareError}
            />
          )}
      </div>
    </nav>
  );
}
