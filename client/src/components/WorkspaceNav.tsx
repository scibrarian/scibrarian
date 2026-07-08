import { useEffect, useRef, useState } from "react";
import type { Collection, Disease } from "../types";
import { useClickOutside } from "../lib/hooks";
import { SkeletonBar } from "./Skeleton";

export type Mode = "discover" | "papers";

// Two-part navigation: a Discover / My Papers mode switch, plus a dropdown that
// picks the active topic (MeSH search) or collection within that mode. The
// dropdown replaces per-item tabs so a long list never clutters the header.
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));

  // Collapse the menu whenever the mode changes out from under it.
  useEffect(() => setOpen(false), [mode]);

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
          📁 My Papers
        </button>
      </div>

      <div className="ws-picker" ref={ref}>
        {/* Until the first load resolves we don't yet know if there are any
            topics/collections, so show a placeholder rather than flashing the
            "No topics yet" empty state. */}
        {!loaded ? (
          <div className="ws-trigger ws-trigger-loading" aria-hidden="true">
            <SkeletonBar w={128} h={14} />
          </div>
        ) : (
          <button
            className="ws-trigger"
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <span className="ws-current">{label}</span>
            {typeof count === "number" && <span className="count">{count}</span>}
            <span className="ws-caret">▾</span>
          </button>
        )}

        {open && loaded && (
          <div className="ws-menu" role="listbox">
            {inDiscover ? (
              <>
                {diseases.map((d) => (
                  <button
                    key={d.id}
                    className={`ws-option ${d.id === activeDiseaseId && !settingsActive ? "active" : ""}`}
                    onClick={() => {
                      onSelectDisease(d.id);
                      setOpen(false);
                    }}
                  >
                    <span className="ws-option-name">{d.name}</span>
                    <span className="count">{d.articleCount ?? 0}</span>
                  </button>
                ))}
                {diseases.length === 0 && <div className="ws-empty">No topics yet.</div>}
                <button
                  className="ws-add"
                  onClick={() => {
                    onAddTopic();
                    setOpen(false);
                  }}
                >
                  ＋ Add topic…
                </button>
              </>
            ) : (
              <>
                {collections.map((c) => (
                  <button
                    key={c.id}
                    className={`ws-option ${c.id === activeCollectionId && !settingsActive ? "active" : ""}`}
                    onClick={() => {
                      onSelectCollection(c.id);
                      setOpen(false);
                    }}
                  >
                    <span className="ws-option-name">📁 {c.name}</span>
                    <span className="count">{c.matchedCount}</span>
                  </button>
                ))}
                {collections.length === 0 && <div className="ws-empty">No collections yet.</div>}
                <button
                  className="ws-add"
                  onClick={() => {
                    onCreateCollection();
                    setOpen(false);
                  }}
                >
                  ＋ New collection
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
