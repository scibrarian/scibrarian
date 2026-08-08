import type { Request, Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { OrgHolding, ProStatus } from "../../shared/pro.js";

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

export function proLoaded(): boolean {
  return mod != null;
}

/** null in a free build — which is exactly what GET /auth reports. */
export function proStatus(): ProStatus | null {
  return mod?.status() ?? null;
}

export function proRoutes(): Router | null {
  return mod?.routes() ?? null;
}

/**
 * The org half of the custody question, for the /have lines that came back not
 * held locally.
 *
 * Returns null both when there is no Pro module and when the master could not
 * be reached, and those two collapse deliberately: **the local verdict must
 * never depend on the network.** A writer asking whether the agency already
 * bought a paper gets the same held/not-held answer with the master down as
 * with it up; the org line is an addition on top, and its absence degrades to
 * exactly the free-tier answer rather than to a wrong one.
 */
export async function orgCheck(pmids: string[]): Promise<Map<string, OrgHolding> | null> {
  if (!mod || pmids.length === 0) return null;
  try {
    return await mod.orgCheck(pmids);
  } catch (err) {
    console.warn(`[pro] org check unavailable: ${(err as Error).message}`);
    return null;
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
 * The catch is narrow on purpose. A blanket `catch { return null }` would make
 * a Pro module that *throws during init* indistinguishable from one that isn't
 * installed, silently downgrading a paying customer to the free tier — which
 * looks like the product working rather than like a bug, and reaches support as
 * "sync stopped" with no signal anywhere.
 */
const PRO_SPECIFIER = "@scibrarian/pro";

export async function loadPro(ctx: ProContext): Promise<ProModule | null> {
  let imported: { default?: ProModule };
  try {
    imported = (await import(PRO_SPECIFIER)) as { default?: ProModule };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return null;
    throw err;
  }
  const m = imported.default;
  if (!m) throw new Error(`${PRO_SPECIFIER} loaded but exported no default module`);
  await m.init(ctx);
  registerPro(m);
  return m;
}
