import { useState } from "react";

type BannerKind = "error" | "success" | "info";

// A dismissible status banner. Clicking × hides the current message; a different
// message re-shows on its own (dismissal is tracked by the message text), so
// callers don't need a `key`. `onDismiss` is optional — pass it when the source
// is clearable local state (so the state matches what's on screen); omit it for
// data-load errors that come from a fetch hook (hiding the banner is enough,
// clearing the hook's error would just reveal a stuck skeleton).
export function Banner({
  kind,
  message,
  onDismiss,
}: {
  kind: BannerKind;
  message: string;
  onDismiss?: () => void;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (dismissed === message) return null;
  return (
    <div className={`banner ${kind} dismissible`}>
      <span>{message}</span>
      <button
        className="banner-close"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(message);
          onDismiss?.();
        }}
      >
        ×
      </button>
    </div>
  );
}
