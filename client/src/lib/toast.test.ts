// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { showToast } from "./toast";

// The one piece of the UI built as raw DOM rather than as a component, so no
// render test touches it and a break here shows up only on screen. What is
// worth pinning is the pair of exits — the animation's and the button's — since
// they are the same removal reached two ways, and the split between the live
// region and the control inside it, which is invisible unless read aloud.

const toast = () => document.querySelector(".toast");
const dismissButton = () => document.querySelector<HTMLButtonElement>(".toast-dismiss");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the toast", () => {
  it("shows the message it was given", () => {
    showToast("Removed 340 papers.");
    expect(toast()?.textContent).toContain("Removed 340 papers.");
  });

  it("announces the message alone, without the dismiss control", () => {
    showToast("Removed 340 papers.");
    // Not `toContain`: the point is that the live region stops short of the
    // button, so a screen reader doesn't read "Dismiss" as part of the news.
    expect(document.querySelector("[role='status']")?.textContent).toBe("Removed 340 papers.");
  });

  it("goes away when the dismiss button is pressed", () => {
    showToast("Copied link to clipboard.");
    dismissButton()?.click();
    expect(toast()).toBeNull();
  });

  it("goes away on its own when the animation ends", () => {
    showToast("Copied link to clipboard.");
    toast()?.dispatchEvent(new Event("animationend"));
    expect(toast()).toBeNull();
  });

  it("keeps one at a time, so a second message replaces the first", () => {
    showToast("Added 2 new papers.");
    showToast("Removed 340 papers.");
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    expect(toast()?.textContent).toContain("Removed 340 papers.");
  });
});
