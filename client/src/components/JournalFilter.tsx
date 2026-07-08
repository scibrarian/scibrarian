import { useRef, useState } from "react";
import { useClickOutside } from "../lib/hooks";

// Multiselect journal filter. A fixed-height dropdown trigger (rather than a
// wrapping row of chips) keeps the toolbar from cluttering — or shifting the
// layout — when a topic spans many journals. Selection is tracked as the set of
// *deselected* journals so a journal that newly appears (e.g. after a refresh)
// is shown by default.
export function JournalFilter({
  journals,
  deselected,
  onChange,
}: {
  journals: string[];
  deselected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));

  const selectedCount = journals.reduce((n, j) => n + (deselected.has(j) ? 0 : 1), 0);
  const label =
    selectedCount === journals.length
      ? "All journals"
      : selectedCount === 0
        ? "No journals"
        : `${selectedCount} of ${journals.length} journals`;

  const toggle = (j: string) => {
    const next = new Set(deselected);
    if (next.has(j)) next.delete(j);
    else next.add(j);
    onChange(next);
  };

  return (
    <div className="filter-picker" ref={ref}>
      <button
        className="filter-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="filter-label">{label}</span>
        <span className="ws-caret">▾</span>
      </button>

      {open && (
        <div className="filter-menu" role="listbox" aria-multiselectable="true">
          <div className="filter-actions">
            <button className="link-btn" onClick={() => onChange(new Set())}>
              Select all
            </button>
            <button className="link-btn" onClick={() => onChange(new Set(journals))}>
              Deselect all
            </button>
          </div>
          <ul className="filter-list">
            {journals.map((j) => (
              <li key={j}>
                <label className="filter-option">
                  <input
                    type="checkbox"
                    checked={!deselected.has(j)}
                    onChange={() => toggle(j)}
                  />
                  <span className="filter-option-name">{j}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
