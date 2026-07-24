// A single lightweight confirmation toast (e.g. "Copied link to clipboard").
// Only one shows at a time — a new call replaces any current one — and it removes
// itself when its CSS fade animation finishes (see `.toast` in styles.css), so
// there is no timer duration to keep in sync. Deliberately lives outside React:
// it's fire-and-forget UI that shouldn't be tied to any component's lifecycle.
let active: HTMLElement | null = null;

export function showToast(message: string) {
  active?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status"); // implicit polite live region — announces the text
  el.textContent = message;
  el.addEventListener("animationend", () => {
    el.remove();
    if (active === el) active = null;
  });
  document.body.appendChild(el);
  active = el;
}
