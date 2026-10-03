import { describeCacheCleared, errorMessage, formatBytes } from "../lib/format";
import { CACHE_WARN_BYTES, type ViewerCache } from "../lib/viewerCache";
import { ConfirmDialog } from "./Dialogs";

// The header's cache warning: drawn once the viewer cache passes
// CACHE_WARN_BYTES, and gone again the moment a reading comes back under it.
//
// It exists so the size does not have to be gone and looked for. The number
// lives in Settings, at the foot of a panel nobody opens to check on disk use,
// and the cache only ever grows — every paper opened leaves a copy behind — so
// without this the first anyone hears of it is a full disk.
//
// A button rather than a notice with a button in it: the header has room for
// one short label, so the size is the label and pressing it is the clear. It
// goes first in the row for the reason the header's stand-ins give — the row is
// right-aligned, so anything arriving late anywhere but the left end slides
// every control beside it along.
//
// No glyph, and that is a measurement rather than a taste. With a warning
// triangle in it the chip was 9px wider than the header had left beside the
// default workspace name, at the app's full width — enough to put the gear on a
// second row and move the whole page down 44px each time the chip came or went.
// The words do more than the triangle did, so the triangle is what went; the
// fill is the warning pair either way.
//
// Nothing when the reading is missing or failed. A warning has to have a number
// to stand on, and Settings is where an unreadable cache is explained.
export function CacheChip({
  viewerCache,
  onResult,
}: {
  viewerCache: ViewerCache;
  // What the clear did, or why it did not, as a sentence. Handed to the shell
  // rather than drawn here: the chip is gone by the time there is anything to
  // say, since a clear that worked is what takes the cache back under the line.
  onResult: (message: string) => void;
}) {
  const { cache, clearing } = viewerCache;
  if (cache === null || cache === "unreadable" || cache.bytes <= CACHE_WARN_BYTES) return null;
  const size = formatBytes(cache.bytes);

  async function clear() {
    try {
      const cleared = await viewerCache.requestClear();
      // Null is the reader backing out of the confirmation, which needs no
      // report: nothing happened, and they are the one who decided that.
      if (cleared) onResult(describeCacheCleared(cleared));
    } catch (err) {
      onResult(errorMessage(err));
    }
  }

  return (
    <button
      type="button"
      className="cache-chip"
      onClick={clear}
      disabled={clearing}
      title={`Cached copies of your papers are using ${size}. Click to clear them.`}
    >
      {clearing && <span className="btn-spinner" aria-hidden="true" />}
      {/* The visible label says how much and not what pressing it does, which
          the title carries for a pointer and nothing carries for a screen
          reader. Read out ahead of the size rather than in an aria-label, so
          the name still contains the text on the button. */}
      <span className="sr-only">Clear cached copies: </span>
      {clearing ? "Clearing…" : `${size} cached`}
    </button>
  );
}

// The confirmation every clear goes through, from the chip above or from the
// button in Settings. Rendered once, by the shell, because both of those ask
// through the same ViewerCache.
//
// What it asks is the one thing the clear cannot find out for itself. The
// server collects everything a viewer has saved before it deletes a copy, so a
// saved annotation is never what is lost — but a paper still open in a viewer
// is out of its reach. On Windows the copy cannot be deleted and is left
// behind. On macOS and Linux it can, and anything saved afterwards goes into a
// file with no name while the viewer reports that it worked (see
// server/src/external-open.ts). Only the reader knows what they have open.
//
// `primary` rather than `danger`: this is the accent button in Settings too,
// and the red is kept for what deletes papers. Cancel still takes the initial
// focus, as in every ConfirmDialog.
export function ClearCacheDialog({ viewerCache }: { viewerCache: ViewerCache }) {
  return (
    <ConfirmDialog
      open={viewerCache.confirming}
      title="Clear cached copies?"
      message="Confirm all of your library papers are closed before continuing."
      confirmLabel="Proceed"
      onConfirm={viewerCache.proceed}
      onCancel={viewerCache.cancel}
    />
  );
}
