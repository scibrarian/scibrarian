import type { ActiveTab } from "../App";
import type { Collection, Disease } from "../types";

export function TabBar({
  diseases,
  collections,
  active,
  onSelect,
  onCreateCollection,
}: {
  diseases: Disease[];
  collections: Collection[];
  active: ActiveTab;
  onSelect: (tab: ActiveTab) => void;
  onCreateCollection: () => void;
}) {
  const isActive = (kind: "disease" | "collection", id: number) =>
    active !== "settings" && active.kind === kind && active.id === id;

  return (
    <nav className="tabbar">
      {diseases.map((d) => (
        <button
          key={`d${d.id}`}
          className={`tab ${isActive("disease", d.id) ? "active" : ""}`}
          onClick={() => onSelect({ kind: "disease", id: d.id })}
        >
          {d.name}
          {typeof d.articleCount === "number" && <span className="count">{d.articleCount}</span>}
        </button>
      ))}

      {(diseases.length > 0 || collections.length > 0) && <span className="tab-divider" />}

      {collections.map((c) => (
        <button
          key={`c${c.id}`}
          className={`tab collection-tab ${isActive("collection", c.id) ? "active" : ""}`}
          onClick={() => onSelect({ kind: "collection", id: c.id })}
          title={`${c.matchedCount} of ${c.fileCount} files matched`}
        >
          <span className="tab-glyph">📁</span>
          {c.name}
          <span className="count">{c.matchedCount}</span>
        </button>
      ))}

      <button className="tab add-tab" onClick={onCreateCollection} title="New collection">
        + Collection
      </button>

      <button
        className={`tab settings-tab ${active === "settings" ? "active" : ""}`}
        onClick={() => onSelect("settings")}
      >
        ⚙ Settings
      </button>
    </nav>
  );
}
