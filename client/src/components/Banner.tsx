import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

type BannerKind = "error" | "success" | "info";

// A dismissible status banner. Clicking × hides the current message; a different
// message re-shows on its own, so callers don't need a `key`.
//
// Always rendered, with `message` carrying the presence: pass the nullable state
// that holds the text and let the banner decide whether there is anything to
// draw. That is the opposite of the `{msg && <Banner …/>}` the call sites used
// to write, and it is what lets the close animate — a collapse needs the element
// to outlive the state that named it, so the banner keeps its own copy of the
// message and plays the exit out of that, after the caller's has gone.
//
// Handing the caller its state back on the click rather than at the end of the
// collapse is the point of the arrangement, not a detail of it. Deferring it
// left a --dur-base window in which the caller still held the text being
// dismissed, so the same sentence raised again inside that window — an import
// poll settling in CollectionView, say — was a set to a byte-identical string:
// React bailed out of the render, no prop changed, and the close landed and
// cleared it. There was nothing for the banner to notice. Clearing first makes a
// re-raise a real null → text transition, which is what the first effect below
// is watching for.
//
// `onDismiss` is optional — pass it when the source is clearable local state (so
// the state matches what's on screen); omit it for data-load errors that come
// from a fetch hook (hiding the banner is enough, clearing the hook's error
// would just reveal a stuck skeleton). Without it the caller keeps its message
// and the banner stays hidden until the text becomes something else.
export function Banner({
  kind,
  message,
  onDismiss,
}: {
  kind: BannerKind;
  message: string | null;
  onDismiss?: () => void;
}) {
  // What is on screen, which is not what the caller is holding: this outlives
  // the prop for as long as the collapse takes. The kind travels with it, so a
  // caller that reads its kind off the same nullable object it just cleared
  // (Settings' reset report) has nothing left to keep alive for the exit.
  const [shown, setShown] = useState<{ kind: BannerKind; message: string } | null>(null);
  // Closing, but still on screen: .leaving reverses the opening transition, and
  // the banner is only really gone once that has run. Kept apart from `shown`
  // because the two answer different questions — this one is "on the way out",
  // that one is "what is in the box".
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Text arriving shows it and calls off any close in progress: the banner the
  // user was dismissing is not the one now in the box, and letting the collapse
  // finish would take the new message down with it. Empty reads as absent, which
  // is what the `&&` at the call sites used to mean.
  useEffect(() => {
    if (!message) return;
    setShown({ kind, message });
    setLeaving(false);
  }, [kind, message]);

  // The caller letting go for its own reasons — an error banner going away
  // because the retry worked — still vanishes at once, as it did when the call
  // site owned the mounting. Only a close this banner started may hold the
  // element past the state that named it, and `leaving` is what tells them
  // apart: on the click it is already true, set in the same batch as the clear.
  useEffect(() => {
    if (!message && !leaving) setShown(null);
  }, [message, leaving]);

  // Finish the dismissal when the collapse does.
  //
  // The wait is on the element's own running transitions rather than on a timer
  // or a transitionend listener. getAnimations() reports what is actually
  // running, so the delay is however long the stylesheet says without this file
  // holding a duplicate of the number — and under reduced motion, where the
  // duration tokens are 0ms and no transition starts at all, the list comes back
  // empty and the close lands in the same tick. A transitionend listener would
  // simply never fire there, leaving the banner stuck on screen for good.
  useEffect(() => {
    if (!leaving) return;
    // The message this close belongs to. `shown` is a fresh object per arrival,
    // so identity tells a re-raise of the very same sentence apart from the one
    // being dismissed, and a close landing late leaves the newer one standing.
    const closing = shown;
    const done = () => {
      setShown((s) => (s === closing ? null : s));
      setLeaving(false);
    };
    // The `?.` covers a missing element and the typeof covers a missing method,
    // which are two different absences: jsdom implements neither Element
    // .getAnimations nor the transitions it would report, so under a component
    // test the call throws inside the effect, React surfaces it as an unhandled
    // error, and `done()` is never reached — leaving the element in the DOM
    // playing a collapse that never ends, with the caller's state already given
    // back. Nothing to ask reads the same as nothing running: close now.
    const el = ref.current;
    const running = typeof el?.getAnimations === "function" ? el.getAnimations() : [];
    if (running.length === 0) return done();
    let cancelled = false;
    // allSettled, not all: a transition that is interrupted rejects, and an
    // interrupted close still has to end in the banner going away.
    void Promise.allSettled(running.map((a) => a.finished)).then(() => {
      if (!cancelled) done();
    });
    return () => {
      cancelled = true;
    };
    // `shown` is read where the close starts, not depended on: this fires on the
    // flip into `leaving`, and text arriving meanwhile is the first effect's to
    // handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  if (!shown) return null;
  return (
    <div ref={ref} className={`banner ${shown.kind} dismissible${leaving ? " leaving" : ""}`}>
      <span>{shown.message}</span>
      <button
        className="banner-close"
        aria-label="Dismiss"
        // Both halves on the click: the class starts the collapse, and giving
        // the caller its state back here rather than when the collapse ends is
        // what keeps a message raised meanwhile from going down with it.
        onClick={() => {
          setLeaving(true);
          onDismiss?.();
        }}
      >
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}
