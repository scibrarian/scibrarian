import type { Request, Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { OrgHolding, ProStatus } from "../../shared/pro.js";
import { errMessage } from "./util.js";

// The open-core seam.
//
// The Pro module is a separate, private workspace that may or may not be
// present in a given build: the public image ships without it, the Pro image
// with it. This file is the *only* thing either side knows about the other, and
// it lives in the open repo on purpose — the rule that keeps this from becoming
// two codebases is that **the open repo owns every interface and every call
// site; the closed repo owns only implementations.** If a free-tier code path
// needs an `if (pro)` branch, the branch belongs here or at the call site, never
// behind the split.
//
// Every accessor below answers falsy in a free build, so callers read as one
// line rather than a feature check plus a body.

/**
 * What the Pro module hands back at load time.
 *
 * `init` receives a context rather than the module importing server internals
 * by relative path across the workspace boundary. That keeps the surface a
 * declared one: adding a capability to Pro means widening ProContext here, in
 * the open repo, where the widening is visible.
 */
export interface ProContext {
  db: DatabaseSync;
  /**
   * The public admin predicate, injected rather than re-implemented.
   *
   * Pro routes are mounted outside the admin gate (a paired node is not an
   * admin), but Pro's *owner-facing* routes — minting a pairing code, revoking
   * a node — are ordinary owner actions and must answer to the same token as
   * the rest of the API. Handing the predicate across the seam keeps one
   * definition of "is the owner", so a change to admin auth can't leave Pro
   * checking the old rule.
   */
  isAdminRequest(req: Request): boolean;
  /**
   * Which of these PMIDs this instance actually holds a file for.
   *
   * Injected rather than re-queried inside Pro, because "held" carries an
   * invariant the whole product rests on: it means a `collection_files` row,
   * never an `articles` row. A paper a topic feed turned up is one you have
   * *seen*. A master answering "held" for a row it has only seen is the one
   * answer this must never give — it sends a writer to ask for a file nobody
   * has, and the next step after that is buying it anyway.
   */
  heldPmids(pmids: string[]): Set<string>;
  /** The stored PDF behind a held PMID, for serving to a paired node. */
  heldFile(pmid: string): { path: string; fileName: string } | null;
  /** Find or create a collection by name. */
  ensureCollection(name: string): number;
  /**
   * Files in a collection that are matched to a paper — the candidates for a
   * push.
   *
   * Matched only, because identity between instances is the PMID and only the
   * PMID. An unmatched file has nothing the other end could file it under, and
   * sending one would put a paper on the agency's shelf that no query reaches.
   *
   * `file_name` arrives sanitised and each row names its collection — the pair
   * readFileBytes wants. Both are properties of this call, not requests of the
   * caller; see pro-storage for why neither can be left to the other side.
   */
  matchedFilesIn(
    collectionId: number
  ): { id: number; collection_id: number; pmid: string; file_name: string }[];
  /**
   * The stored bytes for one file row, read as part of a collection. Null if
   * the row is gone, the blob is gone, or the row is not in that collection.
   *
   * Takes the pair rather than a bare file id so the engagement boundary is
   * checked on this side of the seam. Pass the `collection_id` that came back
   * with the candidate, never one re-derived alongside it.
   */
  readFileBytes(collectionId: number, fileId: number): Buffer | null;
  /** File bytes pulled from a master as a held paper. Null if they aren't a PDF. */
  storePulledFile(o: {
    bytes: Buffer;
    fileName: string;
    pmid: string;
    collectionId: number;
  }): Promise<{ fileId: number; hash: string } | null>;
}

export interface ProModule {
  readonly version: string;
  init(ctx: ProContext): void | Promise<void>;
  /**
   * Routes mounted at /api/pro. These carry their own authentication — see the
   * mount in index.ts for why they must not sit behind the admin gate.
   */
  routes(): Router;
  status(): ProStatus;
  /**
   * Which of these PMIDs the organisation supplied, mapped to its name.
   *
   * By PMID, not by file id: a paper's `file_id` resolves to the lowest-id
   * file, so a paper held in several collections names one arbitrarily — which
   * is precisely the all-collections view this badge exists for.
   */
  pulledOrgByPmid(pmids: string[]): Map<string, string>;
  /**
   * Ask the paired master which of these PMIDs it holds. Keyed by PMID; absent
   * means not held. Network-dependent by nature, so callers must treat a
   * rejection as "no answer" rather than "not held" — see orgCheck below.
   */
  orgCheck(pmids: string[]): Promise<Map<string, OrgHolding>>;
}

let mod: ProModule | null = null;

/** Pass null to clear it — which is what a test asserting free-tier behaviour does. */
export function registerPro(m: ProModule | null): void {
  mod = m;
}

/** null in a free build — which is exactly what GET /auth reports. */
export function proStatus(): ProStatus | null {
  return mod?.status() ?? null;
}

/**
 * Provenance for a page of papers. Empty map in a free build, so callers spread
 * it in unconditionally and add nothing.
 *
 * Synchronous and local on purpose — this runs inside the /papers response
 * path, and a badge is never worth a network call or an await on the list every
 * view of the app is built from.
 *
 * A throw degrades to the free-tier answer, for the same reason orgCheck's does:
 * this decorates the papers list, and the papers list is the view the whole app
 * is built from. Letting a failure inside Pro's own provenance query — a bad row,
 * a locked database, a schema half-applied — escape into the /papers handler
 * takes out every paper from every source, free-tier rows included, over a
 * label. The badge is additive; its absence understates provenance, which is why
 * the failure is logged rather than swallowed silently, but a page of papers
 * missing a badge beats no page of papers.
 */
export function pulledOrgByPmid(pmids: string[]): Map<string, string> {
  if (!mod || pmids.length === 0) return new Map();
  try {
    return mod.pulledOrgByPmid(pmids);
  } catch (err) {
    // Once per /papers request while the module stays broken. Left unthrottled:
    // this is meant to be unreachable, and a log that repeats is how anyone
    // finds out it wasn't.
    console.warn(`[pro] provenance unavailable: ${errMessage(err)}`);
    return new Map();
  }
}

/**
 * How long a Pro module gets to answer an org check before the line is dropped.
 *
 * A backstop, not the budget. A module is expected to bound its own network
 * calls, and the current one allows itself 4s; this is for the case where one
 * doesn't. `orgCheck` is an interface method and nothing in its type promises a
 * bound, so without a ceiling here a master whose host drops packets — a VPN
 * down, a laptop asleep — rather than refusing the connection holds
 * GET /api/have open for the OS TCP timeout, minutes on some platforms. That
 * takes the *local* verdict down with it, which is the one thing this file
 * promises the network can never do.
 *
 * Set well above any sane module budget on purpose: in an ordinary failure the
 * module's own error should surface with its own message, not lose a race to
 * this.
 */
const ORG_CHECK_BACKSTOP_MS = 10_000;

/**
 * The org half of the custody question, for the /have lines that came back not
 * held locally.
 *
 * Returns null when there is no Pro module, when the master could not be
 * reached, and when nothing answered in time. Those collapse deliberately:
 * **the local verdict must never depend on the network.** A writer asking
 * whether the agency already bought a paper gets the same held/not-held answer
 * with the master down as with it up; the org line is an addition on top, and
 * its absence degrades to exactly the free-tier answer rather than to a wrong
 * one. Latency is part of that promise — an answer that arrives after the
 * reader gave up is not an answer.
 */
export async function orgCheck(pmids: string[]): Promise<Map<string, OrgHolding> | null> {
  if (!mod || pmids.length === 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      mod.orgCheck(pmids),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${ORG_CHECK_BACKSTOP_MS}ms`)),
          ORG_CHECK_BACKSTOP_MS
        );
      }),
    ]);
  } catch (err) {
    console.warn(`[pro] org check unavailable: ${(err as Error).message}`);
    return null;
  } finally {
    // The losing side of a race is never awaited, so an uncleared timer holds
    // an event-loop handle for its full duration after every successful check
    // — which in a test run is a process that will not exit.
    clearTimeout(timer);
  }
}

/**
 * Load the Pro module if this build has one.
 *
 * The specifier is a variable, not a literal, and must stay that way: with a
 * literal, TypeScript resolves the import statically and the *free* checkout —
 * which has no pro/ directory — fails to typecheck. A variable defeats that
 * resolution, so both builds compile from one source tree.
 *
 * Nothing about loading is caught. A blanket `catch { return null }` would make
 * a Pro module that *throws during init* indistinguishable from one that isn't
 * installed, silently downgrading a paying customer to the free tier — which
 * looks like the product working rather than like a bug, and reaches support as
 * "sync stopped" with no signal anywhere. Absence is established first, by
 * `installed()`, so a failure after that point is a real one and stays fatal.
 */
const PRO_SPECIFIER = "@scibrarian/pro";

export async function loadPro(ctx: ProContext): Promise<ProModule | null> {
  if (!installed(PRO_SPECIFIER)) return null;
  const imported = (await import(PRO_SPECIFIER)) as { default?: ProModule };
  const m = imported.default;
  if (!m) throw new Error(`${PRO_SPECIFIER} loaded but exported no default module`);
  await m.init(ctx);
  registerPro(m);
  return m;
}

/**
 * Whether the specifier resolves at all — "is Pro installed?", asked on its own
 * rather than inferred from why an import failed.
 *
 * Matching ERR_MODULE_NOT_FOUND on the import cannot answer it. Node raises
 * that one code for two unrelated things: this package is absent, and this
 * package is present but *its own* import of something else did not resolve — a
 * dependency dropped by `npm ci --omit=dev`, a bad relative path, a bare
 * specifier missing from pro/package.json. Both arrive as
 * `err.code === "ERR_MODULE_NOT_FOUND"`; only the message differs, and it
 * differs by naming a file path instead of the package.
 *
 * Reading the second as the first is the exact silent downgrade the comment
 * above rules out, arrived at through the guard meant to prevent it.
 * import.meta.resolve asks about this specifier and nothing else.
 */
function installed(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}
