import { useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
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
// A Radix tooltip, as the app's dialogs and menus are Radix, and for the same
// reason: the behaviour a hand-rolled one misses. It opens on hover after
// TIP_DELAY_MS and at once on keyboard focus, closes on Escape — only the
// tooltip, not a dialog it sits in, since both are in Radix's one stack of
// layers — and keeps itself beside the icon as the page moves, inside the
// window, flipping above where there is no room below. The pointer can move
// into the bubble to select its text.
//
// The icon is a button and a tab stop, so the help is there for a keyboard as
// well as a mouse. A dialog focuses its first tabbable element when it opens,
// so a dialog with one of these ahead of its first field gives that field
// autoFocus (see TopicDialog).
//
// The text is the button's name, which is what a screen reader reads, and so
// not also its description: Radix would point aria-describedby at the bubble,
// and the same sentence would be read twice. The bubble is hidden from the
// accessibility tree for the same reason, along with the copy Radix keeps in
// it for that description.
//
// Keep it out of a <label> and out of a heading. In a label, a click that
// misses the icon lands on the label and works its control; in a heading, the
// help becomes the heading's name. Beside a field, give it an `id` and point
// the field's aria-describedby at it, which is how the help reaches the field.
// The id goes on a hidden copy of the text rather than on the icon: a
// description is read from what an element says, and the icon says nothing but
// its aria-label, which descriptions don't reliably take.
export function InfoTip({ text, id }: { text: string; id?: string }) {
  const [open, setOpen] = useState(false);
  const icon = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Tooltip.Provider delayDuration={TIP_DELAY_MS}>
        <Tooltip.Root
          open={open}
          onOpenChange={(next) => {
            // Radix closes a tooltip when anything holding its icon scrolls,
            // which suits one a pointer opened in passing and not one the
            // keyboard opened: Tab to an icon below the fold scrolls the page
            // to it, and the help opened and shut in the same moment —
            // measured, gone within 150ms. So a close a scroll asks for is
            // refused while the icon has the focus; the bubble follows the
            // icon as the page moves either way.
            //
            // Radix closes from inside its scroll listener, so the scroll is
            // window.event for the length of this call. Read there rather than
            // flagged from a listener of our own: between listeners for an
            // event the browser dispatches, microtasks run, and a flag cleared
            // by one was gone before Radix's listener ever saw it.
            if (!next && window.event?.type === "scroll" && document.activeElement === icon.current) {
              return;
            }
            setOpen(next);
          }}
        >
          <Tooltip.Trigger asChild>
            <button
              ref={icon}
              type="button"
              className="info-tip"
              aria-label={text}
              aria-describedby={undefined}
              // Radix closes a tooltip when its trigger is pressed, which is
              // right for a button that does something else. This one's only
              // job is the help, and a click on it is someone asking for it.
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => e.preventDefault()}
            >
              <Info size={14} aria-hidden />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            {/* Placed afresh every frame while open. Radix's default watches the
                icon for moves and is prompt about small ones, but once the
                icon has jumped clear of where it was — a banner landing above
                it — it waits a second before looking again, and for that
                second the bubble points at nothing. One small bubble, open
                for a moment, is cheap to place each frame. */}
            <Tooltip.Content
              className="tip-bubble"
              aria-hidden
              side="bottom"
              align="start"
              sideOffset={GAP}
              collisionPadding={MARGIN}
              updatePositionStrategy="always"
            >
              {text}
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
      {id && (
        <span id={id} hidden>
          {text}
        </span>
      )}
    </>
  );
}
