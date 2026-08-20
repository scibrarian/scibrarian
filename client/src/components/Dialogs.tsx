import { useLayoutEffect, useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";

// Radix-backed replacements for window.prompt/confirm. Radix supplies the
// behavior a hand-rolled modal misses — focus trap, Escape, focus restore, aria
// wiring — while the existing .modal CSS supplies the look. Its outside-click
// dismissal is the one piece deliberately turned off; see the Content below.
// Content nests inside Overlay so the backdrop's flex centering keeps working.
export function ModalFrame({
  open,
  onClose,
  wide = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop">
          <Dialog.Content
            className={wide ? "modal wide" : "modal"}
            aria-describedby={undefined}
            // Clicking the backdrop no longer dismisses. Radix offers it by
            // default and for a menu it is right, but every dialog in this app
            // holds something a stray click should not throw away: a half-typed
            // name, a staged set of journal moves, a reference list that took a
            // paste and a wait to produce. The gesture is also the one people
            // make to bring a window forward, so it fires by accident far more
            // often than it is meant.
            //
            // Escape is deliberately still live, and so is the × — two ways out
            // that both require aiming at the dialog. Losing the backdrop
            // without gaining a visible control would have left only a keystroke.
            onInteractOutside={(e) => e.preventDefault()}
          >
            {children}
            {/* Last in the DOM, and drawn where it looks first: .modal-close is
                position: absolute against a position: relative .modal, so the
                order here costs nothing visually and decides two other things.

                Radix focuses the first tabbable element on open. With the ×
                first, every dialog without an autoFocus opened with focus on
                its close control — measured: ConfirmDialog's initial focus was
                button.modal-close, ahead of Cancel. That is survivable, since
                Enter on the × closes rather than confirms, but it is not what
                ConfirmDialog's own comment describes and it is not what should
                be relied on: the property worth keeping is that a destructive
                dialog opens on its safe action, by construction rather than by
                the × happening to be harmless.

                Tab order follows the same order and reads better for it — the
                dialog's actual content first, the way out last. */}
            <Dialog.Close className="modal-close" aria-label="Close">
              <X size={20} aria-hidden />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The frame plus the ordinary heading, which is every dialog but one.
 *
 * The exception is the citation graph's paper card: its title is a button that
 * opens the PDF, and a metadata line sits above it. That is why the frame is
 * separate rather than ModalShell simply growing a `title?: ReactNode` — the
 * graph needs the frame's behaviour and none of its heading, and the shape it
 * needs is not a variant of this one. Splitting them is what stops that dialog
 * hand-rolling a second Dialog.Content and drifting, which is exactly what it
 * had done: it was the one dialog the backdrop rule above never reached.
 */
export function ModalShell({
  open,
  onClose,
  title,
  wide = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <ModalFrame open={open} onClose={onClose} wide={wide}>
      <Dialog.Title className="modal-heading">{title}</Dialog.Title>
      {children}
    </ModalFrame>
  );
}

/**
 * What is actually destroyed when papers leave a collection — shared by the two
 * dialogs that ask, because they destroy the same thing at different scales and
 * had already drifted apart on how they punctuated it.
 *
 * It used to end "your original files are untouched", and that came out. Three
 * things were wrong with it. It answered a question only one of the two dialogs
 * raises — nobody deleting four rows out of a list fears for their hard drive,
 * so raising it there invented the worry it then allayed. It implied the app
 * could reach a local file at all, which it cannot: an upload sends bytes, and
 * the store renames the server's own temp copy of them. And it wasn't reliably
 * true, because a paper pulled from an organisation's library was never a file
 * of this user's to begin with.
 *
 * What is left is the fact worth knowing before pressing the button: the stored
 * copy goes, unless it is shared with another collection.
 */
export const STORED_COPIES_NOTE =
  "Any stored PDF copies are deleted, unless another collection also holds the same file.";

// Confirmation dialog. Cancel is the first tabbable thing in it, so it takes
// initial focus and Enter never destroys anything by default — which holds only
// because ModalFrame puts its × last; see the note there.
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalShell open={open} onClose={onCancel} title={title}>
      <p className="modal-message">{message}</p>
      <div className="modal-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

// Single-text-field dialog (replaces window.prompt). Submits on Enter; the
// submit button stays disabled until the value is non-blank.
export function PromptDialog({
  open,
  title,
  placeholder,
  initialValue = "",
  inputType = "text",
  maxLength,
  submitLabel,
  option,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  placeholder?: string;
  initialValue?: string;
  inputType?: "text" | "password";
  /**
   * Longest value the box will accept, for the names that have a cap (see
   * MAX_NAME_CHARS). Omitted where there isn't one — the admin token is
   * whatever the operator set, and a cap there would silently truncate it.
   */
  maxLength?: number;
  submitLabel: string;
  /**
   * An optional pre-filled choice shown beneath the input.
   *
   * Pre-filled, never a gate: the dialog submits whether or not it is touched.
   * A forced confirmation gets pattern-matched and clicked through within a
   * week, leaving the same failure mode plus a step everyone resents.
   */
  option?: { label: string; hint?: string; defaultChecked: boolean };
  onSubmit: (value: string, optionChecked: boolean) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [checked, setChecked] = useState(option?.defaultChecked ?? false);

  // Each opening starts fresh; a stale draft from the last use would be worse
  // than empty. Runs in a layout effect (before paint) so the previous session's
  // text can't flash for a frame before being reset to initialValue.
  useLayoutEffect(() => {
    if (open) {
      setValue(initialValue);
      setChecked(option?.defaultChecked ?? false);
    }
  }, [open, initialValue, option?.defaultChecked]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (v) onSubmit(v, checked);
  }

  return (
    <ModalShell open={open} onClose={onCancel} title={title}>
      <form className="modal-form" onSubmit={handleSubmit}>
        <input
          type={inputType}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoFocus
          maxLength={maxLength}
        />
        {option && (
          <label className="modal-option">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span>
              {option.label}
              {option.hint && <span className="hint">{option.hint}</span>}
            </span>
          </label>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!value.trim()}>
            {submitLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
