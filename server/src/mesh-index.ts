import { articlesMissingMesh, meshBacklogCount, saveArticleMesh } from "./db.js";
import { MESH_STATUS_UNAVAILABLE } from "./pubmed-parse.js";
import { fetchArticleXml } from "./pubmed.js";
import { errMessage } from "./util.js";

// The second half of ingestion, not the one-time catch-up the name suggests.
//
// A paper's XML is fetched exactly once, when the poller first sees it (see
// newPmids in poller.ts — articles already stored are linked to a topic without
// a refetch). The poller finds papers while they are new, so most arrive
// In-Process or Publisher, carrying no MeshHeadingList: NLM assigns the
// headings weeks or months later. This is the only thing that ever asks again,
// so without it those papers stay unfiled for good and the subject filter fills
// only from the minority that were already indexed on first sight.
//
// The work list is re-queried from the database each pass rather than
// snapshotted, so a crash, a restart, or an article deleted mid-run just
// changes the next query's answer. There is no cursor to persist and no state
// that can disagree with the database. What makes it terminate is that every
// write stamps a non-empty status and mesh_checked_at, so a row leaves the list
// either by settling or by falling inside the recheck window — including rows
// PubMed didn't return at all, which are stamped MESH_STATUS_UNAVAILABLE rather
// than left to be re-fetched forever.
//
// It needs no breather between batches because every request already goes
// through pubmed.ts's shared throttle, which is also what keeps it from
// crowding out a poll or an import running at the same time.

const BATCH = 100; // PMIDs per efetch — the poller's batch size

let running = false;

export async function backfillArticleMesh(): Promise<void> {
  if (running) return; // one at a time; the next trigger finds whatever is left
  const pending = meshBacklogCount();
  if (pending === 0) return;
  running = true;
  console.log(`[mesh-index] filing MeSH headings for ${pending} article(s)…`);
  let filed = 0;
  let unfiled = 0;
  let missing = 0;
  try {
    for (;;) {
      const pmids = articlesMissingMesh(BATCH);
      if (pmids.length === 0) break;
      const records = await fetchArticleXml(pmids);
      const rows = pmids.map((pmid) => {
        const x = records.get(pmid);
        if (!x) {
          // PubMed answered, but not about this one — a withdrawn PMID, or a
          // response that dropped it. Recorded as "ask again later" so it stops
          // being re-requested every pass; see MESH_STATUS_UNAVAILABLE.
          missing++;
          return { pmid, status: MESH_STATUS_UNAVAILABLE, headings: [] };
        }
        if (x.mesh.length > 0) filed++;
        else unfiled++;
        return { pmid, status: x.status, headings: x.mesh };
      });
      saveArticleMesh(rows);
    }
    const parts = [`${filed} filed`];
    // Not a failure: most of these are papers PubMed holds but MEDLINE doesn't
    // index, which is exactly the state the status column exists to record.
    if (unfiled > 0) parts.push(`${unfiled} with no headings`);
    if (missing > 0) parts.push(`${missing} not returned by PubMed`);
    console.log(`[mesh-index] filing done: ${parts.join(", ")}`);
  } catch (err) {
    // An NCBI outage mid-run leaves everything already written in place and the
    // rest still on the work list, so the next trigger simply resumes. Nothing
    // is awaiting this, so it logs rather than throws.
    console.warn(
      `[mesh-index] filing stopped after ${filed + unfiled + missing} article(s): ${errMessage(err)}`
    );
  } finally {
    running = false;
  }
}
