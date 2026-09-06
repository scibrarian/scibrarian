// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PromptDialog } from "./Dialogs";

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
