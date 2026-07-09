import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

// Multiselect journal filter. A fixed-height dropdown trigger (rather than a
// wrapping row of chips) keeps the toolbar from cluttering — or shifting the
// layout — when a topic spans many journals. Selection is tracked as the set of
// *deselected* journals so a journal that newly appears (e.g. after a refresh)
// is shown by default. Every item preventDefaults its select so the menu stays
// open while toggling several journals in a row.
export function JournalFilter({
  journals,
  deselected,
  onChange,
}: {
  journals: string[];
  deselected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
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
    <div className="filter-picker">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="filter-trigger">
          <span className="filter-label">{label}</span>
          <span className="ws-caret">▾</span>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content className="filter-menu" align="start" sideOffset={6} loop>
            <div className="filter-actions">
              <DropdownMenu.Item
                className="link-btn"
                onSelect={(e) => {
                  e.preventDefault();
                  onChange(new Set());
                }}
              >
                Select all
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="link-btn"
                onSelect={(e) => {
                  e.preventDefault();
                  onChange(new Set(journals));
                }}
              >
                Deselect all
              </DropdownMenu.Item>
            </div>
            <div className="filter-list">
              {journals.map((j) => (
                <DropdownMenu.CheckboxItem
                  key={j}
                  className="filter-option"
                  checked={!deselected.has(j)}
                  onCheckedChange={() => toggle(j)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {/* Purely visual — the CheckboxItem itself carries the
                      role/aria-checked semantics. */}
                  <input
                    type="checkbox"
                    checked={!deselected.has(j)}
                    readOnly
                    tabIndex={-1}
                    aria-hidden="true"
                    style={{ pointerEvents: "none" }}
                  />
                  <span className="filter-option-name">{j}</span>
                </DropdownMenu.CheckboxItem>
              ))}
            </div>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
