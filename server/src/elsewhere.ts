// "You already own this — it's in your Acme workspace."
//
// Workspaces keep one agency's material out of another's, and that isolation
// reopens the exact hole the whole custody feature exists to close. The local
// half of /have sees one database. Working in Agency B's workspace, it cannot
// see a paper the writer bought personally or acquired under Agency A, so it
// answers "not held" — and they buy it a second time, with their own money,
// being the party in the chain with no budget.
//
// So the local check unions PMIDs across every workspace on this machine.
// Read-only, metadata only, no file transfer, nothing leaves the disk.
//
// **Local holdings only, never org verdicts.** That is the line, and it is the
// reason this module reads `collection_files` and nothing else. A local union
// tells the writer about papers already on their own laptop. Unioning the org
// answer would surface what Acme's master holds inside a Bristol session, which
// is precisely the leak workspaces exist to prevent — so no master is contacted
// here, no Pro table is read, and the other workspace's pairing is never
// consulted.
//
// Identity is the PMID and only the PMID, for the reason the org check gives:
// a registry keyed on anything softer produces near-miss rows and false
// "someone has it" answers, and that is the one answer this must never get
// wrong.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { heldFile } from "./db.js";
import { otherWorkspaces, workspaceDbPath, workspacesEnabled } from "./workspaces.js";
import { SQL_PARAMS_PER_CHUNK } from "../../shared/sqlite.js";
import { errMessage } from "./util.js";
import type { ElsewhereHolding } from "../../shared/types.js";

export interface ElsewhereResult {
  /**
   * The papers found, by PMID. A hit is always trustworthy: it was read out of
   * a database on this machine.
   */
  holdings: Map<string, ElsewhereHolding>;
  /**
   * Whether an *absence* can be trusted — true only when every other workspace
   * was accounted for.
   *
   * The same distinction orgChecked draws, and it matters for the same reason.
   * A workspace whose database could not be opened has said nothing, and
   * rendering that silence as "you don't own this" is what ends in the
   * duplicate purchase. One unreadable workspace makes the whole answer
   * uncertain rather than only the part it would have covered, because there is
   * no way to say which PMIDs it would have claimed.
   *
   * A workspace with no database file yet — created, never opened — is not a
   * failure: it holds nothing, so it has genuinely answered no. Nor is having no
   * other workspaces at all, where an absence is trivially trustworthy. What
   * makes this false is a build with no workspaces (nothing looked, and the
   * field means nothing there) or a read that threw.
   */
  checked: boolean;
}

// A fresh object each time rather than one shared constant: these are handed
// out to callers, and a Map returned from two calls is one a caller could fill
// on behalf of the other.
const nothing = (): ElsewhereResult => ({ holdings: new Map(), checked: false });

/**
 * Which of these PMIDs are held in some *other* workspace on this machine.
 *
 * Cheap enough to run on the local pass, before anything touches the network:
 * a handful of SQLite files opened by header, one indexed query each. There is
 * no request to spend and no reason to defer it.
 */
export function heldElsewhere(pmids: string[]): ElsewhereResult {
  // Off-desktop there is no such thing as another workspace, and `checked`
  // stays false: nothing looked, which is the honest reading of a field that
  // does not apply.
  if (!workspacesEnabled()) return nothing();
  if (pmids.length === 0) return nothing();

  const holdings = new Map<string, ElsewhereHolding>();
  let failed = 0;

  for (const ws of otherWorkspaces()) {
    const dbPath = workspaceDbPath(ws.id);
    // A workspace created and never opened has no database yet, which is not a
    // failure: it holds nothing, so it has genuinely answered no.
    if (!fs.existsSync(dbPath)) continue;
    try {
      readOne(dbPath, ws.name, pmids, holdings);
    } catch (err) {
      // Logged, never thrown. /have's local verdict is the answer that must
      // survive everything, and a second library that will not open is not a
      // reason to fail the check on the one that did.
      failed++;
      console.warn(`[workspaces] could not read "${ws.name}": ${errMessage(err)}`);
    }
  }

  return { holdings, checked: failed === 0 };
}

/**
 * One other workspace's answer.
 *
 * Opened read-only and closed again rather than kept in a pool. Only one
 * workspace is live at a time (the app holds a single-instance lock and
 * switching restarts it), so these files are static for as long as this process
 * runs and there is nothing to keep a connection warm for — while an open
 * handle on Windows is a file the user cannot move or delete out from under us.
 *
 * Read-only is the enforcement, not the intention: this must not be able to
 * write to another workspace however wrong the query is, and it must not
 * checkpoint or recover a WAL belonging to a library it is only glancing at.
 */
function readOne(
  dbPath: string,
  workspaceName: string,
  pmids: string[],
  into: Map<string, ElsewhereHolding>
): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Chunked for the same reason queryByIds is: a pasted reference list is
    // bounded, but this is the shape that stops being true the moment something
    // else calls it.
    for (let i = 0; i < pmids.length; i += SQL_PARAMS_PER_CHUNK) {
      const chunk = pmids.slice(i, i + SQL_PARAMS_PER_CHUNK);
      const rows = db
        .prepare(
          `SELECT cf.pmid AS pmid, MIN(c.name) AS collection_name
             FROM collection_files cf
             JOIN collections c ON c.id = cf.collection_id
            WHERE ${heldFile("cf.")} AND cf.pmid IN (${chunk.map(() => "?").join(",")})
            GROUP BY cf.pmid`
        )
        .all(...chunk) as { pmid: string; collection_name: string }[];
      for (const row of rows) {
        // First workspace to claim a paper keeps it, and within one workspace
        // MIN(name) picks the collection. Both are arbitrary but stable —
        // registry order is creation order, and a name is a name — and both
        // answer the question actually being asked, which is "do you already
        // own this" rather than "how many copies are there".
        if (!into.has(row.pmid)) {
          into.set(row.pmid, { workspace: workspaceName, collection: row.collection_name });
        }
      }
    }
  } finally {
    db.close();
  }
}
