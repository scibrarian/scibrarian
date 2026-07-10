import { useState } from "react";
import { copyTextToClipboard } from "../lib/clipboard";
import { errorMessage } from "../lib/format";
import type { ShareLinkResponse } from "../types";

// Mints an expiring signed link and puts the absolute URL on the clipboard,
// flashing ✓ for a moment. Used for single files (papers table) and whole
// collections (workspace bar).
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

  async function share() {
    try {
      const { path } = await mint();
      await copyTextToClipboard(new URL(path, window.location.origin).toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
      {copied ? "✓" : "🔗"}
    </button>
  );
}
