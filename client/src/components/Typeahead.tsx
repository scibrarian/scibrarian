import { KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { useDebounced } from "../lib/hooks";

// A controlled ARIA combobox: the parent owns the input text (value/onChange) so
// it can submit the raw text, while this component owns the fetched results,
// keyboard navigation, and dismiss behavior. `search` runs debounced once the
// input reaches `minChars`; selecting an option (click or Enter on the
// highlight) calls `onSelect`. `id` namespaces the ARIA ids so two comboboxes
// can share a page.
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
}: TypeaheadProps<T>) {
  const [results, setResults] = useState<T[]>([]);
  // The results list is a combobox popup: it hides on Escape/blur (dismissed)
  // without discarding the fetched results, and reopens on typing or refocus.
  const [listDismissed, setListDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  const query = useDebounced(value.trim(), debounceMs);
  useEffect(() => {
    setActiveIndex(-1);
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

  const listOpen = !listDismissed && results.length > 0;

  // Keep the keyboard-highlighted option visible in the scrolling list.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function choose(item: T) {
    onSelect(item);
    setResults([]);
    setActiveIndex(-1);
    setListDismissed(false);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (listOpen) {
        e.preventDefault();
        setListDismissed(true);
        setActiveIndex(-1);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (results.length === 0) return;
      e.preventDefault();
      if (!listOpen) {
        setListDismissed(false);
        setActiveIndex(e.key === "ArrowDown" ? 0 : results.length - 1);
        return;
      }
      setActiveIndex((i) => {
        const n = results.length;
        return e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    if (e.key === "Enter" && listOpen && activeIndex >= 0) {
      // Choose the highlighted result, not the raw typed text the form would submit.
      e.preventDefault();
      choose(results[activeIndex]);
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
        onFocus={() => setListDismissed(false)}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={listOpen}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={listOpen && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
      />
      {listOpen && (
        <ul
          className="typeahead-list"
          id={`${id}-list`}
          role="listbox"
          ref={listRef}
          // Keep the input focused while clicking a result, so the blur handler
          // above can't unmount the list before the click lands.
          onMouseDown={(e) => e.preventDefault()}
        >
          {results.map((item, i) => (
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
    </div>
  );
}
