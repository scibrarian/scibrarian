import { blobExists, blobPath } from "./blobstore.js";
import { fileHashesMissingText, pdfTextStats, savePdfText } from "./db.js";
import { extractPdf } from "./pdf-text.js";
import { errMessage } from "./util.js";

// Backfill of the full-text index for PDFs uploaded before it existed (or
// imported while extraction was failing).
//
// Resumable by construction rather than by bookkeeping: the work list is
// re-queried from "blobs with no pdf_text row" each pass, so a crash, a restart
// or a file deleted mid-run simply changes the next query's answer. There is no
// cursor to persist and no state that can disagree with the database.
//
// Deliberately not a foreground job with a progress UI: it is a one-time catch-up
// for an existing library, not something the user initiates. It logs, yields
// between files so a large library can't monopolise the event loop against
// requests, and stops on process exit.

const BATCH = 25; // hashes fetched per query
const YIELD_MS = 15; // breather between files, so search stays responsive

let running = false;

// pdfjs is CPU-bound and synchronous in stretches; this hands the event loop
// back between documents so an import or a search during backfill isn't stalled.
const breathe = () => new Promise((r) => setTimeout(r, YIELD_MS));

export function isIndexingRunning(): boolean {
  return running;
}

export async function backfillPdfText(): Promise<void> {
  if (running) return; // one at a time; the next trigger finds whatever is left
  const { pending } = pdfTextStats();
  if (pending === 0) return;
  running = true;
  console.log(`[pdf-index] backfilling full text for ${pending} PDF(s)…`);
  let indexed = 0;
  let failed = 0;
  let skipped = 0;
  try {
    for (;;) {
      // Offset by everything skipped so far. Those rows write no pdf_text and so
      // stay on the work list; since the list is oldest-first and they are
      // passed over in that order, they collect at its head, and the offset is
      // exactly what steps over them. Without it a batch that was entirely
      // missing blobs returned the same rows on the next pass — which the loop
      // could only escape by giving up on the whole backfill, stranding every
      // unindexed PDF behind them, on this run and every run after it.
      const batch = fileHashesMissingText(BATCH, skipped);
      if (batch.length === 0) break;
      for (const { hash, name } of batch) {
        if (!blobExists(hash)) {
          // A row whose bytes are gone (manual blob-store surgery, a restore
          // from a partial backup). Nothing to extract and nothing to fix here;
          // count it and move on.
          skipped++;
          continue;
        }
        try {
          const extracted = await extractPdf(blobPath(hash));
          savePdfText({
            contentHash: hash,
            text: extracted.fullText,
            pages: extracted.pages,
            truncated: extracted.truncated,
          });
          indexed++;
        } catch (err) {
          // An unreadable PDF must not stall the queue behind it. Store an empty
          // extraction so the row leaves the work list; it is then simply a
          // document that matches nothing, which is the truth.
          console.warn(`[pdf-index] ${name}: extraction failed: ${errMessage(err)}`);
          savePdfText({ contentHash: hash, text: "", pages: 0, truncated: false });
          failed++;
        }
        await breathe();
      }
      // No guard needed to terminate: every row either leaves the work list (a
      // pdf_text row, whether extracted or empty) or advances `skipped`, so each
      // pass strictly shortens what the next query can return.
    }
    const parts = [`${indexed} indexed`];
    if (failed > 0) parts.push(`${failed} unreadable`);
    if (skipped > 0) parts.push(`${skipped} missing from the blob store`);
    console.log(`[pdf-index] backfill done: ${parts.join(", ")}`);
  } finally {
    running = false;
  }
}
