import * as ToggleGroup from "@radix-ui/react-toggle-group";

export type ViewMode = "table" | "timeline" | "graph";

// The views a source can be shown in, in header order. Adding one here is the
// only change a new view needs on the control side — see the note below on
// when this should stop being a segmented control.
const VIEWS: { value: ViewMode; label: string }[] = [
  { value: "table", label: "Papers" },
  { value: "timeline", label: "Timeline" },
  { value: "graph", label: "Graph" },
];

// The Papers / Timeline / Graph switch. A Radix ToggleGroup rather than plain
// buttons: type="single" gives radiogroup/radio semantics (so the active view
// is exposed to screen readers, which a CSS `.active` class alone was not) plus
// roving focus — the group is one tab stop and arrow keys move within it.
//
// A segmented control reads well up to ~5 items. Past that, or once a view
// applies to only one workspace (a fixed row would then be lying about what's
// available), this should become a DropdownMenu — already a dependency, so the
// swap stays inside this file.
export function ViewSwitcher({
  viewMode,
  onChange,
}: {
  viewMode: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <ToggleGroup.Root
      className="view-toggle"
      type="single"
      value={viewMode}
      // Radix allows deselecting the pressed item, which would fire "" and
      // leave no view selected; ignore that and keep the current one.
      onValueChange={(v) => v && onChange(v as ViewMode)}
      loop
      aria-label="View mode"
    >
      {VIEWS.map((v) => (
        <ToggleGroup.Item key={v.value} value={v.value}>
          {v.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
