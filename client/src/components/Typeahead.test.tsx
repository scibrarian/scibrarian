// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Typeahead } from "./Typeahead";

// jsdom has no layout, so no scrollIntoView, which the highlight calls to stay
// in view.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// When the topic box's popup opens, and what it is when it does.
//
// The idle offers (the Library's suggested headings, shown while the box is
// empty) open on a click in the input or an arrow key, never on focus alone:
// a window regaining focus refocuses the input as well, and used to pop the
// offers open over Settings with nobody having asked. A click has to work in
// an input that already has focus, which fires no focus event — that is the
// state every pick and every Escape leaves it in. A note with no offers under
// it is the input's description rather than a listbox with nothing in it.

type Item = { key: string; name: string };
const A: Item = { key: "a", name: "Adipose Tissue" };
const B: Item = { key: "b", name: "Obesity" };

// Controlled, as Settings drives it: the parent owns the text.
function Box(props: {
  idleItems?: Item[];
  idleLabel?: string;
  search?: (q: string) => Promise<Item[]>;
  onSelect?: (item: Item) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Typeahead<Item>
      value={value}
      onChange={setValue}
      search={props.search ?? (async () => [])}
      onSelect={props.onSelect ?? (() => {})}
      renderItem={(m) => m.name}
      getKey={(m) => m.key}
      placeholder="Search MeSH terms"
      id="t"
      idleItems={props.idleItems}
      idleLabel={props.idleLabel}
    />
  );
}

const input = () => screen.getByRole("combobox") as HTMLInputElement;
const options = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("the idle offers", () => {
  it("don't open on focus alone", () => {
    render(<Box idleItems={[A, B]} idleLabel="From your Library" />);
    fireEvent.focus(input());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("open on a click, and on a click again after a pick", () => {
    const onSelect = vi.fn();
    render(<Box idleItems={[A, B]} idleLabel="From your Library" onSelect={onSelect} />);
    fireEvent.mouseDown(input());
    fireEvent.focus(input());
    expect(options()).toEqual(["Adipose Tissue", "Obesity"]);

    fireEvent.click(screen.getByRole("option", { name: "Adipose Tissue" }));
    expect(onSelect).toHaveBeenCalledWith(A);
    expect(screen.queryByRole("listbox")).toBeNull();

    // Still focused — the list keeps focus in the input — so no focus event.
    fireEvent.mouseDown(input());
    expect(options()).toEqual(["Adipose Tissue", "Obesity"]);
  });

  it("open on ArrowDown, with the first one highlighted", () => {
    render(<Box idleItems={[A, B]} idleLabel="From your Library" />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Adipose Tissue" }).getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  it("keep a highlight made while the box's debounce was still running out", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    render(<Box idleItems={[A, B]} idleLabel="From your Library" onSelect={onSelect} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "ab" } });
    act(() => void vi.advanceTimersByTime(200));

    // Cleared, and an offer highlighted before the debounce catches up.
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    act(() => void vi.advanceTimersByTime(200));

    expect(screen.getByRole("option", { name: "Adipose Tissue" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(A);
  });
});

describe("typed results", () => {
  it("still reopen on focus, as they always have", async () => {
    render(<Box search={async () => [B]} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "obes" } });
    await screen.findByRole("option", { name: "Obesity" });

    fireEvent.blur(input(), { relatedTarget: null });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(input());
    expect(options()).toEqual(["Obesity"]);
  });
});

describe("a note with no offers under it", () => {
  const NOTE = "Still reading MeSH headings for 3 papers in your Library.";

  it("is the input's description, not an empty listbox", () => {
    render(<Box idleItems={[]} idleLabel={NOTE} />);
    const note = document.getElementById(input().getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe(NOTE);
    // Described before it is shown: a description is read on focus.
    expect(note?.hidden).toBe(true);

    fireEvent.mouseDown(input());
    expect(note?.hidden).toBe(false);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows on ArrowDown and hides on Escape", () => {
    render(<Box idleItems={[]} idleLabel={NOTE} />);
    const note = () => document.getElementById("t-note")!;
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(note().hidden).toBe(false);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(note().hidden).toBe(true);
  });
});
