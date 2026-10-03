import { KeyboardEvent, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDebounced } from "../lib/hooks";

// A controlled ARIA combobox: the parent owns the input text (value/onChange) so
// it can submit the raw text, while this component owns the fetched results,
// keyboard navigation, and dismiss behavior. `search` runs debounced once the
// input reaches `minChars`; selecting an option (click or Enter on the
// highlight) calls `onSelect`. `id` namespaces the ARIA ids so two comboboxes
// can share a page.
//
// `idleItems` are offered in place of results while the input is empty, once
// asked for — a click in the input or an arrow key, not focus alone, which a
// window regaining focus also delivers. They are options the parent can
// propose before anything is typed, and live in the popup rather than beside
// the input so their arrival never moves the page. `idleLabel` heads them, and
// names the listbox; with no idle items it stands alone as a note, so "nothing
// to offer yet, because…" has a place too.
interface TypeaheadProps<T> {
  value: string;
  onChange: (value: string) => void;
  search: (q: string) => Promise<T[]>;
  onSelect: (item: T) => void;
  renderItem: (item: T, active: boolean) => ReactNode;
  getKey: (item: T) => string;
  placeholder: string;
  id: string;
  minChars?: number;
  debounceMs?: number;
  idleItems?: T[];
  idleLabel?: string;
  // The box takes nothing more — the topic dialog's, once a topic has as many
  // headings as it may. The placeholder is where the parent says why.
  disabled?: boolean;
  // Focused when it mounts — the topic dialog's, whose first tab stop is the
  // info icon ahead of it.
  autoFocus?: boolean;
}

export function Typeahead<T>({
  value,
  onChange,
  search,
  onSelect,
  renderItem,
  getKey,
  placeholder,
  id,
  minChars = 2,
  debounceMs = 200,
  idleItems,
  idleLabel,
  disabled = false,
  autoFocus = false,
}: TypeaheadProps<T>) {
  const [results, setResults] = useState<T[]>([]);
  // The results list is a combobox popup: it hides on Escape/blur (dismissed)
  // without discarding the fetched results, and reopens on typing, a click in
  // the input, an arrow key, or — with text typed — refocus. Dismissed to begin
  // with, or idle items would open it on a page that has not focused the input.
  const [listDismissed, setListDismissed] = useState(true);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  const query = useDebounced(value.trim(), debounceMs);
  useEffect(() => {
    // A highlight made on the last query's results is stale once the query
    // moves on. Not when it settles on empty, though: the box then shows the
    // idle offers, which no query changes, and a highlight made on them while
    // the debounce ran out is the one Enter is about to choose.
    if (query !== "") setActiveIndex(-1);
    if (query.length < minChars) {
      setResults([]);
      return;
    }
    // Guard against out-of-order responses: the cleanup runs before the next
    // query fires, so a slower earlier request can't overwrite newer results
    // (which would show options that don't match the input).
    let active = true;
    search(query)
      .then((r) => {
        if (active) setResults(r);
      })
      .catch(() => {
        if (active) setResults([]);
      });
    return () => {
      active = false;
    };
    // `search` is intentionally omitted: callers may pass an inline closure, and
    // the query text is what identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, minChars]);

  // Idle means empty, not merely short of minChars: one typed letter shows
  // nothing, as before, rather than the idle offers.
  const idle = value.trim() === "";
  const items = idle ? (idleItems ?? []) : results;
  const heading = idle ? idleLabel : undefined;
  // A heading with no options under it is a note, not a listbox: an expanded
  // listbox holding nothing is what a screen reader would announce, with the
  // note itself hidden from it. So it is the input's description instead —
  // rendered, if hidden, whenever it applies, since a description is read on
  // focus whether or not the popup is showing.
  const note = items.length === 0 ? heading : undefined;
  const listOpen = !listDismissed && items.length > 0;
  const popupOpen = listOpen || (!listDismissed && !!note);

  // Keep the keyboard-highlighted option visible in the scrolling list. Runs
  // before paint so the option scrolls into view in the same frame the highlight
  // moves, instead of one frame later.
  useLayoutEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Closed after a pick, which clearing the results used to do by itself; an
  // emptied input would otherwise swap straight to the idle offers. Typing,
  // clicking the input or an arrow key opens it again.
  function choose(item: T) {
    onSelect(item);
    setResults([]);
    setActiveIndex(-1);
    setListDismissed(true);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (popupOpen) {
        e.preventDefault();
        setListDismissed(true);
        setActiveIndex(-1);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (items.length === 0) {
        // Nothing to move through, but a note is shown the way options are.
        if (note && !popupOpen) {
          e.preventDefault();
          setListDismissed(false);
        }
        return;
      }
      e.preventDefault();
      if (!listOpen) {
        setListDismissed(false);
        setActiveIndex(e.key === "ArrowDown" ? 0 : items.length - 1);
        return;
      }
      setActiveIndex((i) => {
        const n = items.length;
        return e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    if (e.key === "Enter" && listOpen && activeIndex >= 0 && activeIndex < items.length) {
      // Choose the highlighted result, not the raw typed text the form would submit.
      e.preventDefault();
      choose(items[activeIndex]);
    }
  }

  return (
    <div
      className="typeahead"
      onBlur={(e) => {
        // focusout bubbles; only dismiss when focus leaves the whole combobox
        // (input + list), not when it moves between them.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setListDismissed(true);
          setActiveIndex(-1);
        }
      }}
    >
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setListDismissed(false);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKey}
        // A click opens it even in an input that already has focus, which fires
        // no focus event: after a pick, or Escape, the next click is how the
        // placeholder's "click for suggestions" gets asked again.
        onMouseDown={() => setListDismissed(false)}
        // Focus alone reopens typed results, as it always has, but not the idle
        // offers: a window regaining focus refocuses the input too, and would
        // pop them open over the page with nobody having asked.
        onFocus={() => {
          if (!idle) setListDismissed(false);
        }}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        role="combobox"
        aria-expanded={listOpen}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={listOpen && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
      />
      {listOpen && (
        <ul
          className="typeahead-list"
          id={`${id}-list`}
          role="listbox"
          aria-label={heading}
          ref={listRef}
          // Keep the input focused while clicking a result, so the blur handler
          // above can't unmount the list before the click lands.
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* Hidden from the accessibility tree: it is already the listbox's
              name, and text is not something a listbox may hold. */}
          {heading && (
            <li role="presentation" aria-hidden="true" className="typeahead-heading">
              {heading}
            </li>
          )}
          {items.map((item, i) => (
            <li key={getKey(item)} role="presentation">
              <button
                type="button"
                role="option"
                id={`${id}-option-${i}`}
                aria-selected={i === activeIndex}
                tabIndex={-1}
                className={`typeahead-item${i === activeIndex ? " active" : ""}`}
                onClick={() => choose(item)}
              >
                {renderItem(item, i === activeIndex)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && (
        <div
          className="typeahead-list"
          id={`${id}-note`}
          hidden={!popupOpen}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="typeahead-heading">{note}</div>
        </div>
      )}
    </div>
  );
}
