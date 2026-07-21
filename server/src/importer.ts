import { randomUUID } from "node:crypto";
import {
  existingPmids,
  pendingCollectionFiles,
  setFileError,
  setFileMatched,
  setFileUnmatched,
  upsertArticles,
} from "./db.js";
import { blobPath } from "./blobstore.js";
import { extractPdfText } from "./pdf-text.js";
import { findDois, findPmid } from "./pdf-match.js";
import { fetchArticles, resolveDoiToPmid } from "./pubmed.js";
import { warmCitations } from "./poller.js";
import type { CollectionFile, ImportJob } from "./types.js";
import { chunk, errMessage, safeMessage } from "./util.js";

// One import job per collection, in memory. Single-user app: a server restart
// mid-import simply leaves rows in 'pending', and the next import resumes them
// (the job always drives off pendingCollectionFiles). Finished jobs stay in the
// map (until the next import overwrites them) so the client can read the final
// tallies. The ImportJob shape lives in shared/types.ts.

const jobs = new Map<number, ImportJob>();

export function getImportStatus(collectionId: number): ImportJob | null {
  return jobs.get(collectionId) ?? null;
}

export function isImportRunning(collectionId: number): boolean {
  return jobs.get(collectionId)?.state === "running";
}

// Files per NCBI resolution round: extraction is local and fast, so batching
// only exists to amortize eutils calls and keep progress moving visibly.
const RESOLVE_BATCH = 50;
// PMIDs per esummary/efetch call (matches the poller's batch size).
const FETCH_BATCH = 100;

export function startImport(collectionId: number, collectionName: string): ImportJob {
  const pending = pendingCollectionFiles(collectionId);
  const job: ImportJob = {
    jobId: randomUUID(),
    state: "running",
    total: pending.length,
    processed: 0,
    matched: 0,
    unmatched: 0,
    errors: 0,
    currentFile: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(collectionId, job);
  void runImport(job, pending, collectionName);
  return job;
}

interface Candidate {
  file: CollectionFile;
  pmid: string | null; // from an explicit PMID label
  dois: string[];
}

async function runImport(
  job: ImportJob,
  files: CollectionFile[],
  label: string
): Promise<void> {
  try {
    for (const batch of chunk(files, RESOLVE_BATCH)) {
      // 1) Extract text + regex candidates. Files with nothing to go on are
      //    settled immediately; the rest go to NCBI resolution.
      const candidates: Candidate[] = [];
      for (const f of batch) {
        job.currentFile = f.file_name;
        let text: string;
        try {
          text = await extractPdfText(blobPath(f.content_hash));
        } catch (err) {
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
      const newlyMatched = await resolveCandidates(candidates, job);
      await warmCitations(newlyMatched, label);
    }
    job.state = "done";
  } catch (err) {
    job.state = "error";
    // Served by /collections/:id/import/status, so scrub it like any other
    // client-facing body; the log keeps the real cause.
    console.warn(`[import] ${label}: failed: ${errMessage(err)}`);
    job.error = safeMessage(err);
  } finally {
    job.currentFile = null;
    job.finishedAt = new Date().toISOString();
  }
}

// Ensure metadata exists locally for these candidate PMIDs; returns the subset
// that PubMed actually recognizes. This is what keeps a garbage regex hit from
// ever entering a collection.
async function validatePmids(pmids: string[]): Promise<Set<string>> {
  const distinct = [...new Set(pmids)];
  const valid = existingPmids(distinct);
  const unknown = distinct.filter((p) => !valid.has(p));
  for (const batch of chunk(unknown, FETCH_BATCH)) {
    const articles = await fetchArticles(batch);
    upsertArticles(articles);
    for (const a of articles) valid.add(a.pmid);
  }
  return valid;
}

// Match candidates by explicit PMID first (free), then by DOI→PMID lookup.
// Returns the PMIDs newly matched in this round (for citation warming).
async function resolveCandidates(candidates: Candidate[], job: ImportJob): Promise<string[]> {
  if (candidates.length === 0) return [];
  const matchedPmids: string[] = [];

  const validRegexPmids = await validatePmids(
    candidates.filter((c) => c.pmid).map((c) => c.pmid!)
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
      if (pmid) {
        doiResolved.set(c, pmid);
        break;
      }
    }
  }

  const validDoiPmids = await validatePmids([...doiResolved.values()]);
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
