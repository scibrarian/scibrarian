import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

// How long the pointer rests on the icon before its help appears.
//
// The reason this draws its own bubble rather than setting `title`: a native
// tooltip's delay is the browser's and no page can change it. Browsers wait
// about half a second; this is half of that, which is as long as it takes to
// tell a pointer that stopped from one passing over.
export const TIP_DELAY_MS = 250;

// How far the bubble sits from the icon, and from the edge of the window.
const GAP = 6;
const MARGIN = 8;

// Help for the thing it sits beside, kept out of the way until it is asked
// for: what would otherwise be a sentence under a heading or a field, read
// once and in the way from then on.
//
// Shown on hover after TIP_DELAY_MS. The text is also the icon's label, which
// is what reads it out — an icon alone says nothing to a screen reader, and
// inside a <label> this is how the help still reaches the field's name, as the
// sentence under it used to. The bubble is therefore hidden from the
// accessibility tree: it would be the same sentence a second time.
//
// Not a tab stop, deliberately. A dialog gives its first tabbable element the
// focus when it opens, and in the topic dialog that would be this icon ahead
// of the field it explains.
export function InfoTip({ text }: { text: string }) {
  const icon = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const timer = useRef<number>();
  const [open, setOpen] = useState(false);
  // Where the bubble goes, once it has been measured. Null for the one render
  // it spends off screen being measured.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  const show = () => {
    window.clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setAt(null);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Under the icon and starting at its left edge, pulled back inside the window
  // where that would run off it, and put above the icon where there is no room
  // below. Fixed to the viewport and drawn in a portal, so a scrolling dialog
  // or list that holds the icon can't clip it.
  useLayoutEffect(() => {
    if (!open || !icon.current || !bubble.current) return;
    const i = icon.current.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(i.left, window.innerWidth - b.width - MARGIN));
    const below = i.bottom + GAP;
    const top = below + b.height + MARGIN <= window.innerHeight ? below : i.top - GAP - b.height;
    setAt({ left, top: Math.max(MARGIN, top) });
  }, [open, text]);

  // A bubble fixed to the viewport would be left behind by a scroll, pointing
  // at where the icon was.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <span
      ref={icon}
      className="info-tip"
      role="img"
      aria-label={text}
      onMouseEnter={() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(show, TIP_DELAY_MS);
      }}
      onMouseLeave={hide}
      // Inside a <label>, a click anywhere is a click on its control. Reading
      // the help for a switch must not flip it.
      onClick={(e) => e.preventDefault()}
    >
      <Info size={14} aria-hidden />
      {open &&
        createPortal(
          <span
            ref={bubble}
            className="tip-bubble"
            aria-hidden="true"
            style={at ? { left: at.left, top: at.top } : { left: 0, top: 0, visibility: "hidden" }}
          >
            {text}
          </span>,
          document.body
        )}
    </span>
  );
}
