// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InfoTip, TIP_DELAY_MS } from "./InfoTip";

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
const icon = () => screen.getByRole("img", { name: TEXT });
const bubble = () => document.querySelector(".tip-bubble");

describe("an info icon's help", () => {
  it("appears once the pointer has rested on it, and not before", () => {
    render(<InfoTip text={TEXT} />);
    fireEvent.mouseEnter(icon());
    act(() => void vi.advanceTimersByTime(TIP_DELAY_MS - 1));
    expect(bubble()).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(bubble()?.textContent).toBe(TEXT);
  });

  it("waits a quarter of a second", () => {
    // Half of the half-second a native tooltip takes. Pinned because the
    // number is the feature.
    expect(TIP_DELAY_MS).toBe(250);
  });

  it("doesn't appear for a pointer that only passed over", () => {
    render(<InfoTip text={TEXT} />);
    fireEvent.mouseEnter(icon());
    act(() => void vi.advanceTimersByTime(TIP_DELAY_MS - 50));
    fireEvent.mouseLeave(icon());
    act(() => void vi.advanceTimersByTime(1000));
    expect(bubble()).toBeNull();
  });

  it("goes when the pointer leaves", () => {
    render(<InfoTip text={TEXT} />);
    fireEvent.mouseEnter(icon());
    act(() => void vi.advanceTimersByTime(TIP_DELAY_MS));
    expect(bubble()).not.toBeNull();
    fireEvent.mouseLeave(icon());
    expect(bubble()).toBeNull();
  });

  it("carries no native tooltip to appear beside its own", () => {
    render(<InfoTip text={TEXT} />);
    expect(icon().hasAttribute("title")).toBe(false);
  });

  it("doesn't pass a click on to the label it sits in", () => {
    const onChange = vi.fn();
    render(
      <label>
        Scheduled polling <InfoTip text={TEXT} />
        <input type="checkbox" onChange={onChange} />
      </label>
    );
    fireEvent.click(icon());
    expect(onChange).not.toHaveBeenCalled();
  });
});
