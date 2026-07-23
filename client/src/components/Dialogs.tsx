import { useLayoutEffect, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

// Radix-backed replacements for window.prompt/confirm. Radix supplies the
// behavior a hand-rolled modal misses — focus trap, Escape/overlay dismiss,
// focus restore, aria wiring — while the existing .modal CSS supplies the look.
// Content nests inside Overlay so the backdrop's flex centering keeps working.
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
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop">
          <Dialog.Content className={wide ? "modal wide" : "modal"} aria-describedby={undefined}>
            <Dialog.Title className="modal-heading">{title}</Dialog.Title>
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Confirmation dialog. Cancel is first in the DOM so it takes initial focus —
// Enter never destroys anything by default.
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
  submitLabel,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  placeholder?: string;
  initialValue?: string;
  inputType?: "text" | "password";
  submitLabel: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);

  // Each opening starts fresh; a stale draft from the last use would be worse
  // than empty. Runs in a layout effect (before paint) so the previous session's
  // text can't flash for a frame before being reset to initialValue.
  useLayoutEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (v) onSubmit(v);
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
        />
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
