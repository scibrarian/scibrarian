import { useEffect, useRef, useState } from "react";
import { Share2, Check } from "lucide-react";
import { copyTextToClipboard } from "../lib/clipboard";
import { errorMessage } from "../lib/format";
import { showToast } from "../lib/toast";
import type { ShareLinkResponse } from "../types";

// Mints an expiring signed link and puts the absolute URL on the clipboard, then
// flashes ✓ on the button and pops a "Copied link to clipboard" toast so the copy
// is unmistakable. Used for single files (papers table) and whole collections
// (workspace bar).
export function ShareLinkButton({
  mint,
  title,
  ariaLabel,
  onError,
}: {
  mint: () => Promise<ShareLinkResponse>;
  title: string;
  ariaLabel: string;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();

  // Drop the pending reset if we unmount mid-flash (e.g. the row or the whole
  // share control disappears) so it doesn't fire on an unmounted component.
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function share() {
    try {
      const { path } = await mint();
      await copyTextToClipboard(new URL(path, window.location.origin).toString());
      showToast("Copied link to clipboard");
      window.clearTimeout(timer.current);
      setCopied(true);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      onError(errorMessage(err));
    }
  }

  return (
    <button
      className={`share-btn ${copied ? "copied" : ""}`}
      onClick={share}
      aria-label={ariaLabel}
      title={title}
    >
      {copied ? <Check size={16} aria-hidden /> : <Share2 size={16} aria-hidden />}
    </button>
  );
}
