import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Search, Library, ChevronDown, Plus, Folder } from "lucide-react";
import { api } from "../api";
import type { Collection, Topic } from "../types";
import { ShareLinkButton } from "./ShareLinkButton";
import { SkeletonBar } from "./Skeleton";

export type Mode = "discover" | "papers";

// Two-part navigation: a Discover / Library mode switch, plus a dropdown that
// picks the active topic (MeSH search) or collection within that mode. The
// dropdown replaces per-item tabs so a long list never clutters the header.
// Radix DropdownMenu owns the open state and supplies outside-click/Escape
// dismissal, arrow-key navigation, and focus return.
export function WorkspaceNav({
  mode,
  isAdmin,
  onModeChange,
  topics,
  collections,
  activeTopicId,
  activeCollectionId,
  settingsActive,
  loaded,
  tokenRequired,
  onSelectTopic,
  onSelectCollection,
  onCreateCollection,
  onAddTopic,
  onShareError,
}: {
  mode: Mode;
  isAdmin: boolean;
  onModeChange: (m: Mode) => void;
  topics: Topic[];
  collections: Collection[];
  activeTopicId: number | null;
  activeCollectionId: number | null;
  settingsActive: boolean;
  loaded: boolean;
  tokenRequired: boolean;
  onSelectTopic: (id: number) => void;
  onSelectCollection: (id: number) => void;
  onCreateCollection: () => void;
  onAddTopic: () => void;
  onShareError: (message: string) => void;
}) {
  const inDiscover = mode === "discover";
  const activeTopic = topics.find((d) => d.id === activeTopicId);
  const activeCollection = collections.find((c) => c.id === activeCollectionId);

  const label = inDiscover
    ? activeTopic?.name ?? (topics.length ? "Select a topic" : "No topics yet")
    : activeCollection?.name ?? (collections.length ? "Select a collection" : "No collections yet");
  const count = inDiscover ? activeTopic?.articleCount : activeCollection?.matchedCount;

  return (
    <nav className="workspace-nav">
      <div className="mode-switch" role="group" aria-label="Workspace">
        <button className={inDiscover && !settingsActive ? "active" : ""} onClick={() => onModeChange("discover")}>
          <Search size={16} aria-hidden /> Interests
        </button>
        <button className={!inDiscover && !settingsActive ? "active" : ""} onClick={() => onModeChange("papers")}>
          <Library size={16} aria-hidden /> Library
        </button>
      </div>

      <div className="ws-picker">
        {/* Until the first load resolves we don't yet know if there are any
            topics/collections, so show a placeholder rather than flashing the
            "No topics yet" empty state. */}
        {!loaded ? (
          <div className="ws-trigger ws-trigger-loading" aria-hidden="true">
            <SkeletonBar w={128} h={14} />
          </div>
        ) : (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="ws-trigger">
              <span className="ws-current">{label}</span>
              {typeof count === "number" && <span className="count">{count}</span>}
              <span className="ws-caret"><ChevronDown size={16} aria-hidden /></span>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content className="ws-menu" align="start" sideOffset={6} loop>
                {inDiscover ? (
                  <>
                    {topics.map((d) => (
                      <DropdownMenu.Item
                        key={d.id}
                        className={`ws-option ${d.id === activeTopicId && !settingsActive ? "active" : ""}`}
                        onSelect={() => onSelectTopic(d.id)}
                      >
                        <span className="ws-option-name">{d.name}</span>
                        <span className="count">{d.articleCount ?? 0}</span>
                      </DropdownMenu.Item>
                    ))}
                    {topics.length === 0 && <div className="ws-empty">No topics yet.</div>}
                    {isAdmin && (
                      <DropdownMenu.Item className="ws-add" onSelect={onAddTopic}>
                        <Plus size={16} aria-hidden /> Add topic…
                      </DropdownMenu.Item>
                    )}
                  </>
                ) : (
                  <>
                    {collections.map((c) => (
                      <DropdownMenu.Item
                        key={c.id}
                        className={`ws-option ${c.id === activeCollectionId && !settingsActive ? "active" : ""}`}
                        onSelect={() => onSelectCollection(c.id)}
                      >
                        <span className="ws-option-name"><Folder size={14} className="inline-icon" aria-hidden /> {c.name}</span>
                        <span className="count">{c.matchedCount}</span>
                      </DropdownMenu.Item>
                    ))}
                    {collections.length === 0 && <div className="ws-empty">No collections yet.</div>}
                    {isAdmin && (
                      <DropdownMenu.Item className="ws-add" onSelect={onCreateCollection}>
                        <Plus size={16} aria-hidden /> New collection
                      </DropdownMenu.Item>
                    )}
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        {/* Owner-only: copy an expiring link that downloads the active
            collection as a zip. Beside the picker so it's unambiguous what
            gets shared. */}
        {loaded &&
          !inDiscover &&
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
