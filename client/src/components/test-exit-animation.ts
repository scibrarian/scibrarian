import { vi } from "vitest";

// A dialog's exit, for the tests that are about one.
//
// Radix keeps a closing dialog mounted while its exit animation runs, and
// learns which animation that is from the computed style. jsdom has no
// stylesheet here and reports none, so on its own the dialog is gone the moment
// it closes — the one stretch these tests are about. The stand-in reports what
// styles.css gives .modal, one animation open and another closed, and Radix
// then holds the dialog as a browser would.
//
// A spy, so whoever calls this restores it afterwards (vi.restoreAllMocks).
export function withAnExitAnimation() {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    return new Proxy(real(el, pseudo), {
      get(styles, prop) {
        if (prop === "animationName") {
          return (el as HTMLElement).dataset.state === "closed" ? "modal-out" : "modal-in";
        }
        const value = Reflect.get(styles, prop);
        return typeof value === "function" ? value.bind(styles) : value;
      },
    });
  });
}
