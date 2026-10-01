import { flushSync } from "react-dom";

// Commit a state change behind a cross-fade.
//
// The browser's same-document View Transition snapshots the page, runs the
// update, and fades the old pixels into the new ones. That is the one way to
// soften a stand-in → content swap without the empty frame styles.css's
// `.empty` note warns about: a fade applied to the content alone starts from
// nothing, because the stand-in unmounts in the same commit the content
// mounts, and nothing is on screen to fade from. Here both are, one of them
// as a snapshot.
//
// flushSync, because the swap has to be in the DOM by the time the callback
// returns. A batched update would land after the browser took its "new"
// snapshot, and the transition would fade from a stand-in to the same
// stand-in.
//
// Plain where the API is missing, and under reduced motion — checked here
// rather than left to the zeroed duration tokens, because a transition with a
// 0ms animation still snapshots the page and holds input for a frame or two.
// The API check comes first so a test runtime without matchMedia never
// reaches it. The timing lives in styles.css beside the other durations (see
// ::view-transition-old).
export function commitWithFade(update: () => void): void {
  if (
    typeof document.startViewTransition !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}
