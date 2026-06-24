import type { Disease } from "../types";

export function TabBar({
  diseases,
  active,
  onSelect,
}: {
  diseases: Disease[];
  active: number | "settings";
  onSelect: (tab: number | "settings") => void;
}) {
  return (
    <nav className="tabbar">
      {diseases.map((d) => (
        <button
          key={d.id}
          className={`tab ${active === d.id ? "active" : ""}`}
          onClick={() => onSelect(d.id)}
        >
          {d.name}
          {typeof d.articleCount === "number" && <span className="count">{d.articleCount}</span>}
        </button>
      ))}
      <button
        className={`tab settings-tab ${active === "settings" ? "active" : ""}`}
        onClick={() => onSelect("settings")}
      >
        ⚙ Settings
      </button>
    </nav>
  );
}
