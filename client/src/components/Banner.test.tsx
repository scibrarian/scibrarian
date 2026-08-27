// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Banner } from "./Banner";

afterEach(cleanup);

// A caller, shaped like the real ones: nullable state, handed straight to the
// banner, cleared by onDismiss. `ctl.set` is how a test plays the part of
// whatever raises the message — a failed request, or CollectionView's import
// poll settling.
type Ctl = { set?: (m: string | null) => void };
function Host({
  ctl,
  clearable = true,
  onDismissed,
}: {
  ctl: Ctl;
  clearable?: boolean;
  onDismissed?: () => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  ctl.set = setMsg;
  return clearable ? (
    <Banner
      kind="info"
      message={msg}
      onDismiss={() => {
        onDismissed?.();
        setMsg(null);
      }}
    />
  ) : (
    <Banner kind="error" message={msg} />
  );
}

// jsdom runs no transitions and does not implement Element.getAnimations, so a
// close lands in the same tick — which is the reduced-motion path, and worth a
// test of its own below. Everything about the *window* a close leaves open
// needs a collapse that is running and can be told when to finish, so these
// tests supply one.
function holdTheCollapse() {
  let release!: () => void;
  const finished = new Promise<void>((r) => (release = r));
  const proto = Element.prototype as unknown as { getAnimations?: () => unknown[] };
  const had = Object.prototype.hasOwnProperty.call(proto, "getAnimations");
  const original = proto.getAnimations;
  proto.getAnimations = () => [{ finished }];
  return {
    // Let the collapse finish, and let React process what that triggers.
    finish: async () => {
      release();
      await act(async () => {
        await finished;
      });
    },
    restore: () => {
      if (had) proto.getAnimations = original;
      else delete proto.getAnimations;
    },
  };
}

const M = "Lost contact with the import job. Reload to check its status.";

describe("Banner", () => {
  it("draws nothing until there is something to say", () => {
    const ctl: Ctl = {};
    const { container } = render(<Host ctl={ctl} />);
    expect(container.querySelector(".banner")).toBeNull();
  });

  it("shows a message the caller raises", () => {
    const ctl: Ctl = {};
    render(<Host ctl={ctl} />);
    act(() => ctl.set!(M));
    expect(screen.getByText(M)).toBeTruthy();
  });

  it("closes in the same tick when nothing is animating", () => {
    // The reduced-motion path, and the one jsdom gives for free: no
    // getAnimations to ask, so nothing to wait for. Guarded on the method
    // rather than just the element, or this would throw inside the effect and
    // strand the banner with the caller's state already cleared.
    const ctl: Ctl = {};
    const { container } = render(<Host ctl={ctl} />);
    act(() => ctl.set!(M));
    act(() => {
      fireEvent.click(screen.getByLabelText("Dismiss"));
    });
    expect(container.querySelector(".banner")).toBeNull();
  });

  it("hands the caller its state back on the click, not when the collapse ends", async () => {
    const collapse = holdTheCollapse();
    try {
      const ctl: Ctl = {};
      const onDismissed = vi.fn();
      const { container } = render(<Host ctl={ctl} onDismissed={onDismissed} />);
      act(() => ctl.set!(M));
      act(() => {
        fireEvent.click(screen.getByLabelText("Dismiss"));
      });
      // Both at once: the caller has already let go, and the element is still
      // here playing the collapse out of the banner's own copy.
      expect(onDismissed).toHaveBeenCalledTimes(1);
      expect(container.querySelector(".banner.leaving")).not.toBeNull();
      expect(screen.getByText(M)).toBeTruthy();
      await collapse.finish();
      expect(container.querySelector(".banner")).toBeNull();
    } finally {
      collapse.restore();
    }
  });

  it("keeps the very same message when it is raised again mid-collapse", async () => {
    // The window that used to swallow it. The caller still held the identical
    // string, so setting it again was an Object.is no-op React bailed out of —
    // no prop changed, nothing for the banner to notice, and the landing close
    // cleared it. Clearing on the click instead makes this a real null-to-text
    // transition.
    const collapse = holdTheCollapse();
    try {
      const ctl: Ctl = {};
      const { container } = render(<Host ctl={ctl} />);
      act(() => ctl.set!(M));
      act(() => {
        fireEvent.click(screen.getByLabelText("Dismiss"));
      });
      act(() => ctl.set!(M));
      await collapse.finish();
      expect(screen.getByText(M)).toBeTruthy();
      expect(container.querySelector(".banner.leaving")).toBeNull();
    } finally {
      collapse.restore();
    }
  });

  it("keeps a different message raised mid-collapse", async () => {
    const collapse = holdTheCollapse();
    try {
      const ctl: Ctl = {};
      render(<Host ctl={ctl} />);
      act(() => ctl.set!(M));
      act(() => {
        fireEvent.click(screen.getByLabelText("Dismiss"));
      });
      act(() => ctl.set!("The scan failed."));
      await collapse.finish();
      expect(screen.getByText("The scan failed.")).toBeTruthy();
    } finally {
      collapse.restore();
    }
  });

  it("goes at once when the caller clears for its own reasons", async () => {
    // An error banner going away because the retry worked. Nobody is watching
    // that exit, and holding it would leave the element behind the state.
    const collapse = holdTheCollapse();
    try {
      const ctl: Ctl = {};
      const { container } = render(<Host ctl={ctl} />);
      act(() => ctl.set!(M));
      act(() => ctl.set!(null));
      expect(container.querySelector(".banner")).toBeNull();
    } finally {
      collapse.restore();
    }
  });

  describe("without onDismiss, where the caller keeps its message", () => {
    it("hides on the ×, and stays hidden while the text is unchanged", () => {
      const ctl: Ctl = {};
      const { container } = render(<Host ctl={ctl} clearable={false} />);
      act(() => ctl.set!(M));
      act(() => {
        fireEvent.click(screen.getByLabelText("Dismiss"));
      });
      expect(container.querySelector(".banner")).toBeNull();
      act(() => ctl.set!(M));
      expect(container.querySelector(".banner")).toBeNull();
    });

    it("re-shows on its own when the text becomes something else", () => {
      const ctl: Ctl = {};
      render(<Host ctl={ctl} clearable={false} />);
      act(() => ctl.set!(M));
      act(() => {
        fireEvent.click(screen.getByLabelText("Dismiss"));
      });
      act(() => ctl.set!("The scan failed."));
      expect(screen.getByText("The scan failed.")).toBeTruthy();
    });
  });

  it("keeps its kind through a collapse the caller has already cleared", async () => {
    // Settings' reset report reads its kind off the same nullable object it
    // clears, so the kind has to travel with the message rather than be read
    // from the prop on every render of the exit.
    const collapse = holdTheCollapse();
    try {
      function ResetHost({ ctl }: { ctl: Ctl }) {
        const [res, setRes] = useState<{ kind: "success" | "error"; message: string } | null>(null);
        ctl.set = (m) => setRes(m == null ? null : { kind: "error", message: m });
        return (
          <Banner
            kind={res?.kind ?? "info"}
            message={res?.message ?? null}
            onDismiss={() => setRes(null)}
          />
        );
      }
      const ctl: Ctl = {};
      const { container } = render(<ResetHost ctl={ctl} />);
      act(() => ctl.set!("Deleting the library failed."));
      expect(container.querySelector(".banner.error")).not.toBeNull();
      act(() => {
        fireEvent.click(screen.getByLabelText("Dismiss"));
      });
      // The caller's object is gone; the banner is still red on the way out.
      expect(container.querySelector(".banner.error.leaving")).not.toBeNull();
      await collapse.finish();
    } finally {
      collapse.restore();
    }
  });
});
