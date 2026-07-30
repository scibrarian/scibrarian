import cron, { ScheduledTask } from "node-cron";
import { DEFAULT_POLL_CRON } from "./config.js";
import {
  db,
  existingPmids,
  getLastPollAttemptAt,
  getTopic,
  getSettings,
  listTopics,
  listJournals,
  saveArticles,
  setLastPollAttemptAt,
  setTopicLastPolled,
  transaction,
} from "./db.js";
import { ensureCitations } from "./icite.js";
import { backfillJournalIndexing, refreshCatalogIfStale } from "./journal-catalog.js";
import { recheckMeshVersion } from "./mesh-catalog.js";
import { backfillArticleMesh } from "./mesh-index.js";
import { buildTerm, fetchArticles, search } from "./pubmed.js";
import type { PollResult } from "./types.js";
import { chunk, errMessage, safeMessage } from "./util.js";

const BATCH_SIZE = 100;

// Link existing articles to a topic without refetching them from PubMed.
// Returns how many links were newly created — INSERT OR IGNORE reports 0
// changes for a (pmid, topic) row that already existed — so a poll can count
// these toward its "added" delta.
const linkStmt = db.prepare(
  "INSERT OR IGNORE INTO article_topics (pmid, topic_id) VALUES (?, ?)"
);
const linkKnown = transaction((pmids: string[], topicId: number): number => {
  let linked = 0;
  for (const pmid of pmids) linked += Number(linkStmt.run(pmid, topicId).changes);
  return linked;
});

// Warm the citation cache for newly added papers so the graph view doesn't
// have to fetch them on first load. Scoped to the caller's delta (a poll or a
// collection import). Best-effort: never throws, so a slow/failing iCite can't
// fail an otherwise successful run.
export async function warmCitations(pmids: string[], label: string): Promise<void> {
  try {
    await ensureCitations(pmids);
  } catch (err) {
    console.warn(
      `[warm] ${label}: citation warm-up failed (will backfill on graph load): ${errMessage(err)}`
    );
  }
}

// The lower bound for a poll's MeSH-date window, as PubMed's YYYY/MM/DD. Start a
// day before the last poll so an ET-vs-UTC boundary or same-day indexing can't
// slip a record through the seam; re-listing a day is idempotent (insert dedup).
function mhdaWindowStart(lastPolledIso: string): string {
  const d = new Date(lastPolledIso);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "/");
}

export async function pollTopic(id: number): Promise<PollResult> {
  const topic = getTopic(id);
  if (!topic) {
    return { topicId: id, topicName: `#${id}`, found: 0, added: 0, error: "Topic not found" };
  }
  const result: PollResult = { topicId: id, topicName: topic.name, found: 0, added: 0 };
  try {
    const journals = listJournals().map((j) => j.name);
    const term = buildTerm(topic.term, journals);

    // Incremental poll: ask PubMed only for papers whose MeSH Date lands since
    // the last successful poll, instead of re-listing the topic's whole history
    // every time. That still catches older papers PubMed only just indexed with
    // MeSH (see search). The first poll (no watermark) omits the bound and scans
    // everything to seed the topic. If the term or a future per-topic fetch
    // filter ever becomes editable, widening it must clear last_polled_at to
    // force such a re-seed — topic deletion relies on the links being complete
    // (see DELETABLE_TOPIC_ARTICLES in db.ts).
    const mhdaSince = topic.last_polled_at ? mhdaWindowStart(topic.last_polled_at) : undefined;
    const pmids = await search(term, mhdaSince);
    result.found = pmids.length;

    const known = existingPmids(pmids);
    const newPmids = pmids.filter((p) => !known.has(p));

    const savedPmids: string[] = [];
    for (const batch of chunk(newPmids, BATCH_SIZE)) {
      const articles = await fetchArticles(batch);
      saveArticles(articles, id);
      savedPmids.push(...articles.map((a) => a.pmid));
      result.added += articles.length;
    }

    // A paper already stored under another topic may also match this one —
    // link it here too, without a wasteful refetch. A newly created link counts
    // toward `added`: from this feed's view the paper just appeared, even though
    // it wasn't fetched from PubMed. Without this the banner shows "Added 0"
    // while the feed grew.
    const alreadyKnown = pmids.filter((p) => known.has(p));
    result.added += linkKnown(alreadyKnown, id);

    // Warm the citation cache for just-added papers (brand new, so always
    // missing) so their graph opens instantly. Best-effort: a failure must not
    // fail the poll — the graph view lazily backfills any gaps on load, and the
    // 14-day staleness refresh stays lazy there too.
    await warmCitations(savedPmids, topic.name);

    setTopicLastPolled(id, new Date().toISOString());
  } catch (err) {
    // Goes back to the client in /refresh's response body, so it gets the same
    // treatment as an HTTP error body: real cause to the log, authored message
    // (or the generic one) to the UI. A raw failure here would otherwise put a
    // SQLite string or an fs path in the poll banner.
    console.warn(`[poll] ${topic.name}: ${errMessage(err)}`);
    result.error = safeMessage(err);
  }
  return result;
}

export async function pollAll(): Promise<PollResult[]> {
  // Stamped up front, not on completion: the desktop launch catch-up reads this
  // to decide whether to poll, and quitting the app mid-poll must not leave it
  // looking like no attempt was ever made — that would poll again on the next
  // launch, and the next. The cost is that an interrupted run waits for the
  // schedule (or the next stale window) rather than resuming on relaunch.
  setLastPollAttemptAt(new Date().toISOString());
  const results: PollResult[] = [];
  for (const topic of listTopics()) {
    results.push(await pollTopic(topic.id));
  }
  return results;
}

// Serialize every poll — scheduled and manual — through one flag so runs can't
// overlap and multiply NCBI traffic (PubMed rate-limits globally by API key/IP).
// node-cron fires runScheduled without awaiting the prior run, and /refresh can
// fire at any time; either way a poll started while one is in flight is refused,
// not stacked. The check-and-set is race-free on Node's single thread since no
// await sits between them.
let isPolling = false;

// Run `fn` under the poll lock. Returns null if a poll is already in progress.
export async function withPollLock<T>(fn: () => Promise<T>): Promise<T | null> {
  if (isPolling) return null;
  isPolling = true;
  try {
    return await fn();
  } finally {
    isPolling = false;
  }
}

// ---------- scheduler ----------

let task: ScheduledTask | null = null;

// Whether an expression is a schedulable cron string. Exported so the settings
// route can reject bad input up front (a 400) instead of saving it and letting
// rescheduleFromSettings silently fall back to the default below.
export function isValidCron(expr: string): boolean {
  return cron.validate(expr);
}

// Reference data (NLM journal catalog, MeSH descriptors) re-checks daily on a
// fixed schedule, deliberately independent of poll_cron/poll_enabled — turning
// off article polling shouldn't freeze autocomplete data, and long-running
// processes must still pick up NLM's updates without a restart. Cheap while
// fresh: the catalog check reads one settings timestamp (30-day TTL), the MeSH
// check is one small directory fetch. Runs before the default 6am poll so a
// poll after a catalog change sees the new data.
const REFERENCE_REFRESH_CRON = "30 5 * * *";

export function startScheduler(): void {
  rescheduleFromSettings();
  // Created once here, never touched by rescheduleFromSettings, so a settings
  // save can't stop or duplicate it.
  cron.schedule(REFERENCE_REFRESH_CRON, () => {
    void refreshCatalogIfStale();
    void recheckMeshVersion();
    void backfillJournalIndexing();
    // Papers PubMed hadn't finished MeSH-indexing when we stored them come back
    // around here: on a long-running process that's the only thing that ever
    // files them, since nothing else re-reads a paper already stored.
    void backfillArticleMesh();
  });
  scheduleLaunchCatchUp();
}

// ---------- launch catch-up ----------

// A cron schedule only fires while the process is running, and no deployment
// runs forever. A desktop app is the extreme case — closed most of the day, so
// with the default 06:00 poll someone who opens it at lunch would never once be
// there when the timer fires — but a container stopped overnight, a host
// rebooted for updates, and a laptop running `npm start` all miss schedules the
// same way, and none of them has any recourse but clicking Refresh. So a
// startup that finds the schedule was missed runs the poll it missed, whatever
// the process happens to be.
//
// Deliberately not gated on IS_DESKTOP: that's the packaging format, which
// correlates with the problem without being it. What bounds this everywhere is
// the attempt watermark in catchUpIsDue — one poll per stale window no matter
// how often the process restarts.

// Let startup finish and the first requests land before adding PubMed traffic;
// the catch-up is never the reason anyone started the process.
const CATCH_UP_DELAY_MS = 5_000;

// Fraction of the schedule's own period that counts as "missed". Shaved below a
// full period so the common case lands reliably: on a daily schedule, a process
// started around the same time each day would otherwise sit right on the
// boundary, and a start 23h58m after yesterday's would read as not-yet-due and
// skip the day. Five sixths of a daily schedule is 20 hours, which is the window
// this used before it was derived from the cron.
const STALE_FRACTION = 5 / 6;

// Used only when the schedule can't be measured (see staleWindowMs).
const FALLBACK_STALE_MS = 20 * 60 * 60 * 1000;

// How long without a poll means the schedule was missed — read off the schedule
// itself rather than assumed. Someone who sets a weekly cron is asking to be
// polled weekly, and a fixed 20-hour window would have caught up on nearly every
// start from the first day onward, quietly polling several times more often than
// the setting they chose while Settings still showed the weekly cron.
//
// The *longest* gap between upcoming runs, not the shortest or the next one: an
// irregular schedule like "0 6 * * 1,2" alternates 24h and 144h gaps, and only
// the 144h figure guarantees that a window this long means a run was genuinely
// missed rather than simply not due yet. Measured against `task`, so it always
// reflects what is actually scheduled — including the fallback to
// DEFAULT_POLL_CRON that rescheduleFromSettings applies to an invalid
// expression.
function staleWindowMs(): number {
  const runs = task?.getNextRuns(6) ?? [];
  let maxGap = 0;
  for (let i = 1; i < runs.length; i++) {
    maxGap = Math.max(maxGap, runs[i].getTime() - runs[i - 1].getTime());
  }
  return maxGap > 0 ? maxGap * STALE_FRACTION : FALLBACK_STALE_MS;
}

// Whether a watermark is old enough to act on. A missing value — a topic added
// but never polled, or a database that has never polled at all — counts as
// stale: that's exactly when someone is waiting to see results. So does a value
// that won't parse, since the alternative is letting one corrupt timestamp
// freeze a feed forever. `now` is passed in so every check in a single decision
// is judged against one instant rather than a clock that moves down the list.
function isStale(watermark: string | null, now: number, windowMs: number): boolean {
  if (!watermark) return true;
  const at = Date.parse(watermark);
  if (Number.isNaN(at)) return true;
  return at < now - windowMs;
}

// Two questions, and the catch-up needs both to answer yes.
//
// "Have we tried lately?" comes first and is the load-bearing one. Topics only
// get a watermark when a poll *succeeds*, so a topic with a malformed term —
// or every topic, for as long as NCBI is unreachable — stays overdue forever.
// On staleness alone, that state would run a full poll five seconds after every
// start, for good: restart five times and NCBI gets five polls, which is the
// traffic amplification the poll lock exists to prevent. This is also what keeps
// the catch-up safe for a crash-looping container now that it isn't scoped to
// desktop. The attempt watermark advances whether the poll worked or not, so a
// permanent failure costs one poll per stale window instead of one per start.
//
// "Is anything actually stale?" then keeps a machine that polls on schedule, or
// by hand, from catching up on top of it. One overdue topic is enough: pollAll
// covers every topic, and the per-topic MeSH-date window keeps the ones already
// current cheap.
function catchUpIsDue(windowMs: number): boolean {
  const now = Date.now();
  if (!isStale(getLastPollAttemptAt(), now, windowMs)) return false;
  return listTopics().some((t) => isStale(t.last_polled_at, now, windowMs));
}

function scheduleLaunchCatchUp(): void {
  // Gated on the same setting as the schedule itself: someone who turned
  // scheduled polling off is asking not to be polled for, and a poll on every
  // start would be a louder version of what they just disabled.
  if (getSettings().poll_enabled !== "1") return;
  const windowMs = staleWindowMs();
  if (!catchUpIsDue(windowMs)) return;
  const hours = Math.round(windowMs / 3_600_000);
  console.log(`[scheduler] nothing polled in ${hours}h — catching up on startup`);
  // unref so a pending catch-up is never what keeps the process alive. Nothing
  // is awaiting the promise this drops on the floor — runPoll not rejecting is
  // what makes that safe.
  setTimeout(() => void runPoll("catch-up"), CATCH_UP_DELAY_MS).unref();
}

export function rescheduleFromSettings(): void {
  const { poll_cron, poll_enabled } = getSettings();
  if (task) {
    // destroy(), not stop(): node-cron keeps every task it creates in a global
    // registry, and only the 'task:destroyed' event removes it from there. A
    // stopped-but-registered task lives for the process, so stopping and
    // dropping the reference here would leak one per settings save. destroy()
    // stops the runner itself and is synchronous for an inline task.
    task.destroy();
    task = null;
  }
  if (poll_enabled !== "1") {
    console.log("[scheduler] scheduled polling is off");
    return;
  }
  const expr = poll_cron || DEFAULT_POLL_CRON;
  if (!cron.validate(expr)) {
    console.warn(`[scheduler] invalid cron "${expr}" — using default "${DEFAULT_POLL_CRON}"`);
    task = cron.schedule(DEFAULT_POLL_CRON, runScheduled);
    return;
  }
  task = cron.schedule(expr, runScheduled);
  console.log(`[scheduler] polling scheduled: "${expr}"`);
}

function runScheduled(): Promise<void> {
  return runPoll("scheduled");
}

// `label` only distinguishes the log lines — a cron firing and a desktop launch
// catch-up run the identical poll, through the same lock, so neither can stack
// on the other or on a manual /refresh.
//
// Never rejects, by design. Both callers are fire-and-forget triggers with
// nowhere to put an error, and the launch catch-up's timer fires long after
// main() returned, so in the desktop build an unhandled rejection would be
// thrown into the Electron main process — killing the window and the in-process
// server together, showing the user nothing. Failing quietly in the log is the
// right trade for a poll nobody asked for; a manual /refresh still reports its
// errors to the client. Note that pollTopic's own try/catch is not enough here:
// listTopics() in pollAll and getTopic() in pollTopic both read the database
// outside it, and withPollLock rethrows, so a locked or unreadable DB arrives
// as a rejection rather than a per-topic result.error.
async function runPoll(label: string): Promise<void> {
  try {
    const results = await withPollLock(() => {
      console.log(`[scheduler] running ${label} poll...`);
      return pollAll();
    });
    if (results === null) {
      console.log(`[scheduler] ${label} poll skipped: a poll is already running`);
      return;
    }
    const added = results.reduce((s, r) => s + r.added, 0);
    console.log(
      `[scheduler] poll complete: ${added} new paper(s) across ${results.length} topic(s)`
    );
    for (const r of results) {
      if (r.error) console.warn(`[scheduler]   ${r.topicName}: ${r.error}`);
    }
  } catch (err) {
    console.error(`[scheduler] ${label} poll failed: ${errMessage(err)}`);
  }
}
