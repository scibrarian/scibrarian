import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Search, Library, Bookmark, ChevronDown, Plus, Folder, FolderSync } from "lucide-react";
import { api } from "../api";
import type { BookmarkFolder, Collection, CollectionSelection, Topic } from "../types";
import { ShareLinkButton } from "./ShareLinkButton";
import { SkeletonBar } from "./Skeleton";

export type Mode = "interests" | "bookmarks" | "papers";

// One entry in the picker, normalized across the three workspaces so the menu
// renders from a single loop.
interface PickerItem {
  id: number;
  name: string;
  count: number;
  /**
   * Syncs to the organisation paired *right now* — the Library's collections
   * only, and only in a Pro build.
   *
   * Deliberately binary, where the panel in Settings has three states. A
   * collection stamped for a previous engagement is neither shared nor plainly
   * local, but nothing about it syncs and it cannot receive a copy pulled from
   * the master, so a row with one glyph of room has one honest answer: no. The
   * badge above the papers is where the third state is spelled out.
   */
  shared?: boolean;
}

// An entry pinned above the list and divided from it, because it selects a
// *scope* rather than one of the things being scoped. Only the Library has one
// ("All collections"), and it deliberately carries no count: a paper filed in
// two collections is one row in the list but two in the summed totals, so a
// badge here would contradict what the view below it shows.
interface PickerLead {
  name: string;
  active: boolean;
  onSelect: () => void;
}

// Described up front so all three arms share one shape — without the explicit
// type the arms infer as a union and `lead` is only reachable on one of them.
interface Picker {
  items: PickerItem[];
  lead?: PickerLead;
  activeId: number | null;
  onSelect: (id: number) => void;
  folderIcon: boolean;
  empty: string;
  placeholder: string;
  addLabel: string;
  onAdd: () => void;
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
  sharedCollectionIds,
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
  activeCollectionId: CollectionSelection | null;
  // Empty in a free build, and whenever this instance isn't paired — so the
  // icon below simply never changes and no caller has to branch on the tier.
  sharedCollectionIds: Set<number>;
  settingsActive: boolean;
  loaded: boolean;
  tokenRequired: boolean;
  onSelectTopic: (id: number) => void;
  onSelectFolder: (id: number) => void;
  onSelectCollection: (id: CollectionSelection) => void;
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
  const picker: Picker =
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
            items: collections.map((c) => ({
              id: c.id,
              name: c.name,
              count: c.matchedCount,
              shared: sharedCollectionIds.has(c.id),
            })),
            // Shown whenever the Library holds anything, including the
            // single-collection case where it selects the same papers the one
            // collection does. Withholding it until a second collection existed
            // was tried and is worse: a scope that appears at an invisible
            // threshold is one nobody learns exists, and nothing announces its
            // arrival when that second collection is finally added. An "All"
            // that currently equals the only item reads as consistent, not
            // broken. Still gated on there being *something*, because "All
            // collections" above an empty list means nothing.
            lead:
              collections.length > 0
                ? {
                    name: "All collections",
                    active: activeCollectionId === "all",
                    onSelect: () => onSelectCollection("all"),
                  }
                : undefined,
            // The numeric half only. Which collection is highlighted and
            // whether "all" is selected are different questions, and folding
            // them into one field is how a sentinel id gets invented.
            activeId: typeof activeCollectionId === "number" ? activeCollectionId : null,
            onSelect: onSelectCollection,
            folderIcon: true,
            empty: "No collections yet.",
            placeholder: collections.length ? "Select a collection" : "No collections yet",
            addLabel: "New collection",
            onAdd: onCreateCollection,
          };

  const active: PickerItem | undefined = picker.items.find((i) => i.id === picker.activeId);
  // The lead, only when it's the current selection — so the trigger can name it
  // instead of falling through to the placeholder for a perfectly valid choice.
  const lead = picker.lead?.active ? picker.lead : null;
  const label = lead ? lead.name : (active?.name ?? picker.placeholder);
  const activeMode = MODES[mode];
  const ModeIcon = activeMode.icon;

  return (
    <nav className="workspace-nav">
      {/* Hidden outright while it stands in, rather than a named group whose
          every button is hidden under it — that announces "Workspace" and then
          nothing, which is worse than either being absent or being read. The
          buttons are disabled, so nothing inside can take focus while it is.
          Same shape as ViewSwitcherSkeleton, which hides its own container. */}
      <div
        className="mode-switch"
        role="group"
        aria-label="Workspace"
        aria-hidden={!loaded || undefined}
      >
        {/* Skeleton until the first load resolves, like the picker beside it:
            switching workspace before there is anything to switch to lands on an
            empty one, and a live control sitting among skeletons reads as the
            one part of the bar that's ready when it is the least ready of them.
            The real labels go inside the bars (see SkeletonBar) so each is
            exactly the width it replaces and the picker doesn't slide. */}
        {!loaded
          ? // Real buttons, disabled: they pick up `.mode-switch button` and the
            // UA's own button font, so the box and the text metrics are the ones
            // being stood in for rather than a span's approximation of them.
            MODE_ORDER.map(([value, m]) => (
              <button key={value} disabled>
                <SkeletonBar w={16} h={16} />
                <SkeletonBar h={14}>{m.label}</SkeletonBar>
              </button>
            ))
          : /* aria-pressed, not just the class: which workspace you're in is
               state, and drawn on its own it reaches only the people who can see
               the fill. Same condition as the class so the two can't disagree —
               under Settings none of them is pressed, because none is current. */
            MODE_ORDER.map(([value, m]) => (
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
              {/* Guarded on `active` alone. Selecting the lead sets activeId to
                  null (see the picker above), and no item carries a null id, so
                  a lead and an active item are mutually exclusive by
                  construction — testing for both reads as if they could coexist
                  and asks a later reader to preserve a relationship there isn't
                  one of. That the lead draws no count is the same decision as
                  the picker entry not carrying one: summing matchedCount
                  double-counts a paper filed in two collections. */}
              {active && <span className="count">{active.count}</span>}
              <span className="ws-caret"><ChevronDown size={16} aria-hidden /></span>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content className="ws-menu" align="start" sideOffset={6} loop>
                {/* Above the divider because it isn't one of the collections —
                    it's the scope they all sit inside. The mode icon rather
                    than the folder the others carry, for the same reason. */}
                {picker.lead && (
                  <>
                    <DropdownMenu.Item
                      className={`ws-option ${picker.lead.active && !settingsActive ? "active" : ""}`}
                      onSelect={picker.lead.onSelect}
                    >
                      <span className="ws-option-name">
                        <Library size={14} className="inline-icon" aria-hidden /> {picker.lead.name}
                      </span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="ws-sep" />
                  </>
                )}
                {picker.items.map((item) => (
                  <DropdownMenu.Item
                    key={item.id}
                    className={`ws-option ${item.id === picker.activeId && !settingsActive ? "active" : ""}`}
                    onSelect={() => picker.onSelect(item.id)}
                  >
                    <span className="ws-option-name">
                      {/* Same silhouette, different state. Swapping to a
                          share/network glyph was tried and reads as a different
                          *kind* of thing sitting in a list of folders, which is
                          the one thing it isn't — so the folder keeps its shape
                          and gains the sync arrows. The icon is decorative
                          either way, hence the sr-only text: a screen reader
                          gets the fact, not the picture. */}
                      {picker.folderIcon &&
                        (item.shared ? (
                          <FolderSync size={14} className="inline-icon" aria-hidden />
                        ) : (
                          <Folder size={14} className="inline-icon" aria-hidden />
                        ))}{" "}
                      {item.name}
                      {item.shared && <span className="sr-only">, shared with your organization</span>}
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
