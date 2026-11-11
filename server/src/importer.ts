import {
  existingPmids,
  pendingCollectionFiles,
  savePdfText,
  setFileError,
  setFileMatched,
  setFileUnmatched,
  upsertArticles,
} from "./db.js";
import { blobPath } from "./blobstore.js";
import { extractPdf, type PdfExtract } from "./pdf-text.js";
import { findDois, findPmid } from "./pdf-match.js";
import { hintProSync } from "./pro-hooks.js";
import { EUTILS_BATCH, fetchArticles, resolveDoiToPmid } from "./pubmed.js";
import { warmCitations } from "./poller.js";
import type { CollectionFile, ImportJob } from "./types.js";
import { startJob, type JobRun } from "./jobs.js";
import { chunk, errMessage } from "./util.js";

// A collection's scan: reading its pending PDFs and matching each to a paper.
// The job around it — one per collection, how one is stopped, what a reset
// forgets — is jobs.ts's.
//
// Where the scan checks for a cancel (control.check()) is after every await
// that waits on something outside this process: a PDF read, a PubMed request, a
// citation fetch. They are not what keeps a delete clean, so a missed one costs
// work rather than leaving anything behind. savePdfText stores no text for a
// blob no file names, and upsertCitations no counts for a paper that isn't
// stored — which is why the counts a fetch already in flight brings back can
// still be written: they go with their papers in the sweep.

// Files per NCBI resolution round: extraction is local and fast, so batching
// only exists to amortize eutils calls and keep progress moving visibly.
const RESOLVE_BATCH = 50;

export function startImport(collectionId: number, collectionName: string): ImportJob {
  const pending = pendingCollectionFiles(collectionId);
  const logLabel = `[import] ${collectionName}`;
  return startJob("scan", collectionId, pending.length, logLabel, (job, control) =>
    runImport(job, pending, collectionName, control)
  );
}

interface Candidate {
  file: CollectionFile;
  pmid: string | null; // from an explicit PMID label
  dois: string[];
}

async function runImport(
  job: ImportJob,
  files: CollectionFile[],
  label: string,
  control: JobRun
): Promise<void> {
  try {
    for (const batch of chunk(files, RESOLVE_BATCH)) {
      // 1) Extract text + regex candidates. Files with nothing to go on are
      //    settled immediately; the rest go to NCBI resolution.
      const candidates: Candidate[] = [];
      for (const f of batch) {
        job.currentFile = f.file_name;
        let extracted: PdfExtract;
        try {
          // One parse yields both texts: the 3-page slice the matcher is allowed
          // to see, and the capped full text for the search index.
          extracted = await extractPdf(blobPath(f.content_hash));
        } catch (err) {
          // First, because a delete takes the blobs: a cancelled scan's next
          // read fails, and that is not a PDF that couldn't be read.
          control.check();
          // match_error is rendered verbatim next to the file in the UI, and the
          // raw pdfjs/fs message names the blob path — which embeds the
          // content_hash that apiFile() strips precisely because it feeds the
          // share-link MAC. Nothing in it helps the user anyway: the actionable
          // fact is just that this PDF couldn't be read.
          console.warn(`[import] ${f.file_name}: text extraction failed: ${errMessage(err)}`);
          setFileError(f.id, "Couldn't read this PDF.");
          job.errors++;
          job.processed++;
          continue;
        }
        control.check();

        // Indexed even when the file goes on to be unmatched. The text belongs
        // to the blob, not to whether we could pin it to a PubMed record, and
        // re-running the import shouldn't have to parse it again.
        //
        // Caught separately from the parse above, because the two failures mean
        // different things to the user: a parse error is about their PDF and is
        // shown next to the file, while a failed index write is about this
        // process and leaves the match perfectly valid. Sharing one catch
        // reported the write as an unreadable PDF and marked a file that had
        // parsed fine as a match error.
        //
        // This is the only thing that indexes a blob — nothing sweeps up rows
        // with no text afterwards — so a file that lands here is unsearchable
        // until it is uploaded again. Logged loudly for that reason.
        try {
          savePdfText({
            contentHash: f.content_hash,
            text: extracted.fullText,
            pages: extracted.pages,
            truncated: extracted.truncated,
          });
        } catch (err) {
          console.warn(`[import] ${f.file_name}: full-text indexing failed: ${errMessage(err)}`);
        }

        const text = extracted.matchText;
        const pmid = findPmid(text);
        const dois = findDois(text);
        if (!pmid && dois.length === 0) {
          setFileUnmatched(f.id);
          job.unmatched++;
        } else {
          candidates.push({ file: f, pmid, dois });
        }
        job.processed++;
      }

      // 2) Resolve the batch against PubMed and warm citations for new matches.
      const newlyMatched = await resolveCandidates(candidates, job, control);
      await warmCitations(newlyMatched, label);
      control.check();

      // Per batch, not only when the whole job ends. Resolution is one throttled
      // esearch per candidate DOI, so a few thousand files is a job measured in
      // tens of minutes — while the files matched in its first round are
      // copyable seconds after they are matched. Hinting only at the end makes
      // those wait out the whole run, which is the delay this hint exists to
      // remove. The extra calls are free: requestSweep debounces, so batches
      // that land close together still cost one sweep.
      if (newlyMatched.length > 0) hintProSync("import batch matched");
    }
  } finally {
    // Matching is what makes a file copyable — a PMID is the only identity the
    // other end can file by — so this is the moment new work can exist, not the
    // upload that preceded it. Pro sweeps on its own interval regardless; the
    // hint just saves the writer waiting out a tick they have no way to see.
    //
    // The batches above hint as they go; this one is the backstop for the batch
    // that matched files and then threw before reaching its own hint. In the
    // `finally` rather than after the `done` state for that reason: a job that
    // failed part way still matched everything up to the failure, and those
    // files are as eligible as any other. Gated on matched > 0 because a run
    // that matched nothing created no candidate, and the hint would only wake a
    // sweep to re-derive the same empty queue. Nor after a cancel: the files it
    // matched went with their collection.
    if (job.matched > 0 && !control.cancelled) hintProSync("import finished");
  }
}

// Ensure metadata exists locally for these candidate PMIDs; returns the subset
// that PubMed actually recognizes. This is what keeps a garbage regex hit from
// ever entering a collection.
async function validatePmids(pmids: string[], control: JobRun): Promise<Set<string>> {
  const distinct = [...new Set(pmids)];
  const valid = existingPmids(distinct);
  const unknown = distinct.filter((p) => !valid.has(p));
  for (const batch of chunk(unknown, EUTILS_BATCH)) {
    const articles = await fetchArticles(batch);
    control.check();
    upsertArticles(articles);
    for (const a of articles) valid.add(a.pmid);
  }
  return valid;
}

// Match candidates by explicit PMID first (free), then by DOI→PMID lookup.
// Returns the PMIDs newly matched in this round (for citation warming).
async function resolveCandidates(
  candidates: Candidate[],
  job: ImportJob,
  control: JobRun
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const matchedPmids: string[] = [];

  const validRegexPmids = await validatePmids(
    candidates.filter((c) => c.pmid).map((c) => c.pmid!),
    control
  );

  const needDoi: Candidate[] = [];
  for (const c of candidates) {
    if (c.pmid && validRegexPmids.has(c.pmid)) {
      setFileMatched(c.file.id, c.pmid, "pmid");
      job.matched++;
      matchedPmids.push(c.pmid);
    } else if (c.dois.length > 0) {
      needDoi.push(c);
    } else {
      setFileUnmatched(c.file.id); // bogus PMID label, no DOI to fall back on
      job.unmatched++;
    }
  }

  // DOI resolution is one throttled esearch per candidate DOI, so try each
  // file's DOIs in order and stop at the first hit.
  const doiResolved = new Map<Candidate, string>();
  for (const c of needDoi) {
    for (const doi of c.dois) {
      const pmid = await resolveDoiToPmid(doi);
      control.check();
      if (pmid) {
        doiResolved.set(c, pmid);
        break;
      }
    }
  }

  const validDoiPmids = await validatePmids([...doiResolved.values()], control);
  for (const c of needDoi) {
    const pmid = doiResolved.get(c);
    if (pmid && validDoiPmids.has(pmid)) {
      setFileMatched(c.file.id, pmid, "doi");
      job.matched++;
      matchedPmids.push(pmid);
    } else {
      setFileUnmatched(c.file.id);
      job.unmatched++;
    }
  }

  return matchedPmids;
}
