// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InfoTip, TIP_DELAY_MS } from "./InfoTip";
import { ModalShell } from "./Dialogs";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// When the help appears, which is the reason InfoTip draws its own bubble: a
// native `title` waits as long as the browser likes, and this waits half that.

const TEXT = "A paper must carry all of these headings.";
const icon = () => screen.getByRole("button", { name: TEXT });
const bubble = () => document.querySelector(".tip-bubble");
// The bubble's own text, without the unseen copy Radix keeps beside it.
const shown = () => bubble()?.firstChild?.textContent;

// Radix opens on pointer movement over the icon, not on mouseenter.
const rest = () => fireEvent.pointerMove(icon(), { clientX: 5, clientY: 5 });
// A scroll of the page. A browser holds the event in window.event for as long
// as its listeners run, which InfoTip reads to tell a close a scroll asked for
// from any other; jsdom under vitest leaves it stale, so this sets it.
const scroll = () => {
  const event = new Event("scroll");
  Object.defineProperty(window, "event", { value: event, configurable: true });
  try {
    fireEvent(document, event);
  } finally {
    delete (window as { event?: Event }).event;
  }
};
// A finger on a touch screen: down, up, and the click the browser makes of it.
const tap = (target: Element) => {
  fireEvent.pointerDown(target, { pointerType: "touch" });
  fireEvent.pointerUp(target, { pointerType: "touch" });
  fireEvent.click(target);
};
// Leaving the icon starts a corridor towards the bubble that the pointer may
// cross without closing it; a move well clear of both is what closes it.
const leave = () => {
  fireEvent.pointerLeave(icon(), { clientX: 5, clientY: 5 });
  fireEvent.pointerMove(document.body, { clientX: 600, clientY: 600 });
};

describe("an info icon's help", () => {
  it("appears once the pointer has rested on it a quarter of a second, and not before", () => {
    // Half of the half-second a native tooltip takes. Written in milliseconds
    // rather than as TIP_DELAY_MS, which would follow any change to it: the
    // number is the feature.
    render(<InfoTip text={TEXT} />);
    rest();
    act(() => void vi.advanceTimersByTime(249));
    expect(bubble()).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(shown()).toBe(TEXT);
  });

  it("doesn't appear for a pointer that only passed over", () => {
    render(<InfoTip text={TEXT} />);
    rest();
    act(() => void vi.advanceTimersByTime(TIP_DELAY_MS - 50));
    fireEvent.pointerLeave(icon());
    act(() => void vi.advanceTimersByTime(1000));
    expect(bubble()).toBeNull();
  });

  it("goes when the pointer leaves", () => {
    render(<InfoTip text={TEXT} />);
    rest();
    act(() => void vi.advanceTimersByTime(TIP_DELAY_MS));
    expect(bubble()).not.toBeNull();
    leave();
    expect(bubble()).toBeNull();
  });

  it("appears at once for keyboard focus, and Escape takes it away", () => {
    // The help used to be reachable by mouse alone.
    render(<InfoTip text={TEXT} />);
    act(() => icon().focus());
    expect(shown()).toBe(TEXT);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(bubble()).toBeNull();
    expect(document.activeElement).toBe(icon());
  });

  it("stays, for keyboard focus, when the page scrolls to the icon", () => {
    // Tab to an icon below the fold scrolls the page to it; Radix took that
    // scroll as a reason to close what the focus had just opened.
    render(<InfoTip text={TEXT} />);
    act(() => icon().focus());
    scroll();
    act(() => void vi.advanceTimersByTime(0));
    expect(bubble()).not.toBeNull();
  });

  it("still goes on a scroll when a pointer opened it", () => {
    render(<InfoTip text={TEXT} />);
    rest();
    act(() => void vi.advanceTimersByTime(TIP_DELAY_MS));
    expect(bubble()).not.toBeNull();
    scroll();
    expect(bubble()).toBeNull();
  });

  it("stays when the icon is clicked", () => {
    // A click on it is someone asking for the help, so it isn't what closes it.
    render(<InfoTip text={TEXT} />);
    rest();
    act(() => void vi.advanceTimersByTime(TIP_DELAY_MS));
    fireEvent.pointerDown(icon());
    fireEvent.click(icon());
    expect(bubble()).not.toBeNull();
  });

  it("appears on a tap, where no pointer rests on it and no focus comes to it", () => {
    // A touch screen moves no pointer over the icon, and iOS doesn't focus a
    // button that is tapped, so neither of the ways above opened the help
    // there: the tap was all the icon got, and it did nothing with it.
    render(<InfoTip text={TEXT} />);
    tap(icon());
    expect(shown()).toBe(TEXT);
    // Radix starts listening for a press outside the bubble a moment after it
    // opens, and a press on the icon is one.
    act(() => void vi.advanceTimersByTime(1));

    // A second tap leaves it open, and a tap anywhere else closes it.
    tap(icon());
    expect(shown()).toBe(TEXT);
    act(() => void vi.advanceTimersByTime(1));
    tap(document.body);
    expect(bubble()).toBeNull();
  });

  it("is read once, as the icon's name, rather than again as its description or the bubble", () => {
    render(<InfoTip text={TEXT} />);
    act(() => icon().focus());
    expect(icon().hasAttribute("aria-describedby")).toBe(false);
    expect(bubble()?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("carries no native tooltip to appear beside its own", () => {
    render(<InfoTip text={TEXT} />);
    expect(icon().hasAttribute("title")).toBe(false);
  });

  it("describes the field that names it, from beside the field's label", () => {
    // How Settings uses it: the label holds only the words, so a click beside
    // the icon can't reach the control, and the help arrives as the field's
    // description instead of as part of its name.
    render(
      <div>
        <label htmlFor="f">Scheduled polling</label>
        <InfoTip id="f-help" text={TEXT} />
        <input id="f" type="checkbox" role="switch" aria-describedby="f-help" />
      </div>
    );
    expect(screen.getByRole("switch", { name: "Scheduled polling", description: TEXT })).toBeTruthy();
  });

  it("is all that Escape closes inside a dialog, which the next Escape closes", () => {
    // The bubble and the dialog are layers of one Radix stack, and Escape goes
    // to the top one. That holds only while they share a copy of the package
    // that keeps the stack, which is why the tooltip's version is pinned to the
    // release the Dialog came from: a second copy is a second stack, each layer
    // the top of its own, and one Escape closed the help and the topic dialog
    // around it, with whatever was staged there.
    const onClose = vi.fn();
    render(
      <ModalShell open onClose={onClose} title="New topic">
        <InfoTip text={TEXT} />
      </ModalShell>
    );
    act(() => icon().focus());
    expect(shown()).toBe(TEXT);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(bubble()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
