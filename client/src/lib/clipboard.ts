// Copy text to the clipboard. navigator.clipboard needs a secure context
// (HTTPS or localhost); fall back to the legacy path when the app is served
// over plain LAN HTTP — exactly the situation share links are for.
export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    // execCommand returns false instead of throwing when the copy is blocked, so
    // surface it — callers key their "copied" confirmation off a resolved promise.
    if (!ok) throw new Error("Couldn’t copy to the clipboard");
  }
}
