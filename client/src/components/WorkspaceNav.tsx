import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { Collection, Disease } from "../types";
import { SkeletonBar } from "./Skeleton";

export type Mode = "discover" | "papers";

// Two-part navigation: a Discover / Library mode switch, plus a dropdown that
// picks the active topic (MeSH search) or collection within that mode. The
// dropdown replaces per-item tabs so a long list never clutters the header.
// Radix DropdownMenu owns the open state and supplies outside-click/Escape
// dismissal, arrow-key navigation, and focus return.
export function WorkspaceNav({
  mode,
  onModeChange,
  diseases,
  collections,
  activeDiseaseId,
  activeCollectionId,
  settingsActive,
  loaded,
  onSelectDisease,
  onSelectCollection,
  onCreateCollection,
  onAddTopic,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  diseases: Disease[];
  collections: Collection[];
  activeDiseaseId: number | null;
  activeCollectionId: number | null;
  settingsActive: boolean;
  loaded: boolean;
  onSelectDisease: (id: number) => void;
  onSelectCollection: (id: number) => void;
  onCreateCollection: () => void;
  onAddTopic: () => void;
}) {
  const inDiscover = mode === "discover";
  const activeDisease = diseases.find((d) => d.id === activeDiseaseId);
  const activeCollection = collections.find((c) => c.id === activeCollectionId);

  const label = inDiscover
    ? activeDisease?.name ?? (diseases.length ? "Select a topic" : "No topics yet")
    : activeCollection?.name ?? (collections.length ? "Select a collection" : "No collections yet");
  const count = inDiscover ? activeDisease?.articleCount : activeCollection?.matchedCount;

  return (
    <nav className="workspace-nav">
      <div className="mode-switch" role="group" aria-label="Workspace">
        <button className={inDiscover && !settingsActive ? "active" : ""} onClick={() => onModeChange("discover")}>
          🔍 Interests
        </button>
        <button className={!inDiscover && !settingsActive ? "active" : ""} onClick={() => onModeChange("papers")}>
          📚 Library
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
              <span className="ws-caret">▾</span>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content className="ws-menu" align="start" sideOffset={6} loop>
                {inDiscover ? (
                  <>
                    {diseases.map((d) => (
                      <DropdownMenu.Item
                        key={d.id}
                        className={`ws-option ${d.id === activeDiseaseId && !settingsActive ? "active" : ""}`}
                        onSelect={() => onSelectDisease(d.id)}
                      >
                        <span className="ws-option-name">{d.name}</span>
                        <span className="count">{d.articleCount ?? 0}</span>
                      </DropdownMenu.Item>
                    ))}
                    {diseases.length === 0 && <div className="ws-empty">No topics yet.</div>}
                    <DropdownMenu.Item className="ws-add" onSelect={onAddTopic}>
                      ＋ Add topic…
                    </DropdownMenu.Item>
                  </>
                ) : (
                  <>
                    {collections.map((c) => (
                      <DropdownMenu.Item
                        key={c.id}
                        className={`ws-option ${c.id === activeCollectionId && !settingsActive ? "active" : ""}`}
                        onSelect={() => onSelectCollection(c.id)}
                      >
                        <span className="ws-option-name">📁 {c.name}</span>
                        <span className="count">{c.matchedCount}</span>
                      </DropdownMenu.Item>
                    ))}
                    {collections.length === 0 && <div className="ws-empty">No collections yet.</div>}
                    <DropdownMenu.Item className="ws-add" onSelect={onCreateCollection}>
                      ＋ New collection
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
    </nav>
  );
}
