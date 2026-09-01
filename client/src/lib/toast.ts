// A single lightweight confirmation toast (e.g. "Copied link to clipboard").
// Only one shows at a time — a new call replaces any current one — and it removes
// itself when its CSS fade animation finishes (see `.toast` in styles.css), so
// there is no timer duration to keep in sync. Deliberately lives outside React:
// it's fire-and-forget UI that shouldn't be tied to any component's lifecycle.
//
// A dismiss button rides along because the toast now holds the screen for five
// seconds over the workspace bar: long enough that someone who has already read
// it, or who wants the nav underneath, should be able to take it back rather
// than wait the animation out.
let active: HTMLElement | null = null;

// lucide's X, inlined. This file builds DOM directly, so the <X> the rest of the
// app renders (see Banner, the other dismissible message) isn't reachable from
// here; same size and stroke so the two read as the same control. A constant,
// never interpolated — the message goes in through textContent below.
const X_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

export function showToast(message: string) {
  active?.remove();
  const el = document.createElement("div");
  el.className = "toast";

  const dismiss = () => {
    el.remove();
    if (active === el) active = null;
  };

  // The live region wraps the message alone. On the container it would take in
  // the button's label too, so every toast would announce its own dismiss.
  const text = document.createElement("span");
  text.setAttribute("role", "status"); // implicit polite live region
  text.textContent = message;

  // Focusable, so it is reachable by keyboard; if the animation ends while it
  // holds focus the element goes with it and focus falls back to the body,
  // which is the same place a toast that was never touched leaves it.
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-dismiss";
  close.setAttribute("aria-label", "Dismiss");
  close.innerHTML = X_SVG;
  close.addEventListener("click", dismiss);

  el.append(text, close);
  el.addEventListener("animationend", dismiss);
  document.body.appendChild(el);
  active = el;
}
