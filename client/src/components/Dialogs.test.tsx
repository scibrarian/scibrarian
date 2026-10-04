// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog, PromptDialog } from "./Dialogs";
import { withAnExitAnimation } from "./test-exit-animation";

afterEach(cleanup);

// PromptDialog's `option` row, in the shape App.tsx gives it when the instance
// is paired: a statement rather than a question. Every new collection on a
// paired instance is shared, and this row is where the writer is told so while
// naming one — "papers you add here are copied to its library" is the sentence
// that has to land, at the moment it takes effect.
//
// What is pinned here is that being unchangeable never costs the sentence its
// audience. `disabled` on the checkbox took the row out of the tab order, so a
// writer reading by keyboard or screen reader went input → Cancel → Create and
// was never told at all — assistive tech skips disabled controls in forms mode.
// The row is therefore pinned by declining the change, not by refusing focus.
const SHARED = {
  label: "Shared with your organization",
  hint: " Papers you add here are copied to its library — the PDF and its PubMed ID, nothing else.",
  defaultChecked: true,
  disabled: true,
};

function open(option: typeof SHARED | undefined, onSubmit = vi.fn()) {
  render(
    <PromptDialog
      open
      title="New collection"
      submitLabel="Create"
      option={option}
      onSubmit={onSubmit}
      onCancel={() => {}}
    />
  );
  return { onSubmit, box: screen.getByRole("checkbox") as HTMLInputElement };
}

describe("PromptDialog's pinned option row", () => {
  it("states the case where the writer will read it", () => {
    open(SHARED);
    expect(screen.getByText(SHARED.label)).toBeTruthy();
    // Matched loosely: the hint is written with a leading space, which
    // getByText's whitespace normalisation drops.
    expect(screen.getByText(/copied to its library/)).toBeTruthy();
  });

  // The regression. `disabled` is what this must never go back to: it is the
  // one attribute that removes the row from the tab order.
  it("stays reachable, rather than being disabled out of the tab order", () => {
    const { box } = open(SHARED);
    expect(box.disabled).toBe(false);
    expect(box.getAttribute("aria-disabled")).toBe("true");
    box.focus();
    expect(document.activeElement).toBe(box);
  });

  it("declines a click instead of answering it", () => {
    const { box } = open(SHARED);
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });

  it("submits the pinned value, whatever was clicked at it", () => {
    const { onSubmit, box } = open(SHARED);
    fireEvent.click(box);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Trial data" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledWith("Trial data", true);
  });

  // The other half of the prop: without `disabled` the row is an ordinary
  // question, and pinning it must not have made every option row unanswerable.
  it("still answers a click when the caller did not pin it", () => {
    const { onSubmit, box } = open({ ...SHARED, disabled: false });
    expect(box.getAttribute("aria-disabled")).toBe(null);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Local notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledWith("Local notes", false);
  });
});

// A ConfirmDialog on its way out, which is when its words used to change.
//
// The answer to one is usually what changes the thing it asked about. The
// table's "Remove 2 papers?" is titled from the ticks, and removing clears
// them, so for the length of its exit the dialog read "Remove 0 papers?".
//
// The button follows the ticks here too, which no caller's does. It is held
// with the rest, and a fixture that kept it constant could not show that.
const removal = (open: boolean, ticked: number, onConfirm = () => {}) => (
  <ConfirmDialog
    open={open}
    title={`Remove ${ticked} papers?`}
    message={ticked > 0 ? "Only this folder's list changes." : ""}
    confirmLabel={ticked > 0 ? "Remove" : "Nothing to remove"}
    danger={ticked > 0}
    onConfirm={onConfirm}
    onCancel={() => {}}
  />
);

describe("a ConfirmDialog while it closes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the words it was answered with", () => {
    withAnExitAnimation();
    const { rerender } = render(removal(true, 2));
    expect(screen.getByRole("heading", { name: "Remove 2 papers?" })).toBeTruthy();

    // Answered: it closes, and a moment later what it asked about is gone.
    rerender(removal(false, 2));
    rerender(removal(false, 0));
    expect(screen.getByText("Remove 2 papers?")).toBeTruthy();
    expect(screen.getByText("Only this folder's list changes.")).toBeTruthy();
    expect(screen.queryByText("Remove 0 papers?")).toBeNull();
    // The button too: what it said, and that it was the dangerous one.
    expect(screen.getByRole("button", { name: "Remove" }).className).toBe("danger");
    expect(screen.queryByRole("button", { name: "Nothing to remove" })).toBeNull();
  });

  it("asks afresh the next time it opens", () => {
    withAnExitAnimation();
    const { rerender } = render(removal(true, 2));
    rerender(removal(false, 0));
    // Still up, and still the old question: the state the next opening has to
    // leave. Without this the test passes on a dialog that was never held.
    expect(screen.getByText("Remove 2 papers?")).toBeTruthy();
    rerender(removal(true, 5));
    expect(screen.getByRole("heading", { name: "Remove 5 papers?" })).toBeTruthy();
    expect(screen.queryByText("Remove 2 papers?")).toBeNull();
  });

  // The other thing its exit left live was the button. A closing dialog is
  // still painted and still takes a click, so the second half of a double-click
  // reached the caller again — and removing twice is not removing once: the
  // second answer came back "nothing was removed" and replaced the first.
  it("is answered once, though a second click lands on its way out", () => {
    withAnExitAnimation();
    const onConfirm = vi.fn();
    const { rerender } = render(removal(true, 2, onConfirm));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    rerender(removal(false, 2, onConfirm));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

// The same stretch for a PromptDialog, where the second click is a second
// submit: the box still holds the name, so "Create" asked for the collection
// twice, and the second answer was a refusal of the name the first had taken.
describe("a PromptDialog while it closes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("submits once, though a second click lands on its way out", () => {
    withAnExitAnimation();
    const onSubmit = vi.fn();
    const naming = (open: boolean) => (
      <PromptDialog
        open={open}
        title="New collection"
        submitLabel="Create"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />
    );
    const { rerender } = render(naming(true));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Trial data" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    rerender(naming(false));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
