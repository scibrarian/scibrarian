import type { Request, Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import type { OrgHolding, ProStatus } from "../../shared/pro.js";
import type { PaperProvenance } from "../../shared/types.js";
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
  /**
   * A new collection — always an insert, never an adoption.
   *
   * The only way Pro creates one, and deliberately the only way: **a name is
   * never an identity here.** For the master's inbox, "From writers" describes
   * a role rather than a party, so it is a label an owner could plausibly have
   * used already; adopting theirs would point paired nodes at a shelf the owner
   * created for their own purposes — a spoke writing into a collection it is
   * not supposed to be able to see, reached by name collision instead of by
   * request. A find-or-create counterpart used to sit here for the spoke side,
   * where the name was an organisation's own, and it turned out to have the
   * same flaw one step removed: two organisations sharing a display name shared
   * a collection, and a pull from the second claimed everything the first had
   * supplied. Destinations are chosen by the writer and checked against the
   * live pairing now, so nothing is looked up by name at all.
   *
   * Throws when the name is taken — collections are uniquely named, COLLATE
   * NOCASE — so a caller that cannot tolerate that has to say what a collision
   * means. The caller is expected to remember the id rather than call this each
   * time.
   */
  newCollection(name: string): number;
  /** Whether a collection id still resolves — for a caller holding a remembered id. */
  collectionExists(id: number): boolean;
  /**
   * Files in a collection matched to a paper **by evidence** — the candidates
   * for a push.
   *
   * Matched, because identity between instances is the PMID and only the PMID:
   * an unmatched file has nothing the other end could file it under, and
   * sending one would put a paper on the agency's shelf that no query reaches.
   *
   * And never a *manual* match. That one is a person's unverified assertion
   * that a PDF is a given paper — the writer's own business locally, and
   * everyone's once a copy crosses the seam. See pro-storage for the failure it
   * prevents, and manualMatchCountIn for how the exclusion is kept visible.
   *
   * `file_name` arrives sanitised and each row names its collection — the pair
   * readFileBytes wants. Both are properties of this call, not requests of the
   * caller; see pro-storage for why neither can be left to the other side.
   */
  matchedFilesIn(
    collectionId: number
  ): { id: number; collection_id: number; pmid: string; file_name: string }[];
  /**
   * How many files in a collection matchedFilesIn held back for being matched
   * by hand. A count and never the rows, so their ids stay on this side of the
   * seam — the module that reports the number is the one that must not be able
   * to send them.
   */
  manualMatchCountIn(collectionId: number): number;
  /**
   * The stored bytes for one file row, read as part of a collection. Null if
   * the row is gone, the blob is gone, or the row is not in that collection.
   *
   * Takes the pair rather than a bare file id so the engagement boundary is
   * checked on this side of the seam. Pass the `collection_id` that came back
   * with the candidate, never one re-derived alongside it.
   */
  readFileBytes(collectionId: number, fileId: number): Buffer | null;
  /**
   * File bytes pulled from a master as a held paper, onto every chosen shelf.
   * Null if they aren't a PDF, or if the PMID has no article row to be visible
   * under — both properties of the bytes, decided once.
   *
   * Takes all destinations rather than one, so a caller filing a copy into
   * several collections cannot turn that into several hashes of the same
   * buffer. Reports which shelves took the copy and which didn't: a partial
   * result is a real outcome here, not an error, because a copy that reached
   * one shelf is on disk and its row is valid.
   */
  storePulledFile(o: {
    bytes: Buffer;
    fileName: string;
    pmid: string;
    collectionIds: number[];
  }): Promise<{
    hash: string;
    filed: {
      collectionId: number;
      fileId: number;
      /**
       * Whether that row answers as the PMID pulled. False when the shelf
       * already held these exact bytes under a different match, which is never
       * overwritten — so nothing may record the organisation as having supplied
       * a paper the row is not matched to.
       */
      matchedToPull: boolean;
      /** What it is matched to instead. Set only when matchedToPull is false. */
      matchedTo?: string;
    }[];
    failed: { collectionId: number; error: string }[];
  } | null>;
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
   * Which of these PMIDs the organisation supplied — the spoke's half.
   *
   * By PMID, not by file id: a paper's `file_id` resolves to the lowest-id
   * file, so a paper held in several collections names one arbitrarily — which
   * is precisely the all-collections view this badge exists for.
   */
  pulledOrgByPmid(pmids: string[]): Map<string, PaperProvenance>;
  /**
   * The master's mirror: which of these PMIDs a paired node contributed.
   *
   * Separate from pulledOrgByPmid because they answer opposite questions — one
   * is "the org gave me this", the other "a writer gave us this" — and an
   * instance can be both a master and a spoke at once, so one paper can have an
   * answer from each. paperProvenance keeps both rather than picking.
   */
  receivedNodeByPmid(pmids: string[]): Map<string, PaperProvenance>;
  /**
   * Ask the paired master which of these PMIDs it holds. Keyed by PMID; absent
   * means not held. Network-dependent by nature, so callers must treat a
   * rejection as "no answer" rather than "not held" — see orgCheck below.
   */
  orgCheck(pmids: string[]): Promise<Map<string, OrgHolding>>;
  /**
   * Tell the module that something may have created work for the copy-up sweep.
   *
   * A hint, and deliberately nothing more. It carries no collection, no file
   * ids, and no promise that anything is outstanding — the sweep re-derives its
   * whole queue from the database, which is the property the design rests on.
   * Naming a collection here would invite a module to trust it and push on a
   * caller's say-so, which is the push-on-upload hook this seam exists to avoid.
   *
   * `reason` is for the module's own log, so a sweep in a support transcript
   * says what woke it.
   *
   * Advisory, so it returns void and is allowed to do nothing: the module's
   * interval still covers every case this accelerates. A caller must never wait
   * on it or care whether it fired.
   */
  syncHint(reason: string): void;
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
 * A throw degrades *that source* to the free-tier answer, for the same reason
 * orgCheck's does: this decorates the papers list, and the papers list is the
 * view the whole app is built from. Letting a failure inside Pro's own
 * provenance query — a bad row, a locked database, a schema half-applied —
 * escape into the /papers handler takes out every paper from every source,
 * free-tier rows included, over a label. The badge is additive; its absence
 * understates provenance, which is why the failure is logged rather than
 * swallowed silently, but a page of papers missing a badge beats no page of
 * papers. See askProvenance for why each source is contained separately.
 */
export function paperProvenance(pmids: string[]): Map<string, PaperProvenance[]> {
  if (!mod || pmids.length === 0) return new Map();

  // A spoke answers from what it pulled down, a master from what was pushed up,
  // and an instance that is both answers from both — including, for one paper,
  // an answer from each. An agency paired up to a client's master while its own
  // freelancers push up to it can pull a PMID down from the client that one of
  // its writers had already supplied.
  //
  // Both are kept. An earlier version merged the two maps by key on the
  // reasoning that no paper travels in both directions, which is true of a pure
  // spoke or a pure master and false of the hybrid the module explicitly
  // supports; the loser of that merge was silently dropped, and it was the
  // contributed half — the one saying a *writer* covered a purchase the agency
  // then also made — that went. Neither fact is a correction of the other and a
  // licensing question wants both.
  //
  // Org first, so the badge a spoke has always shown is the one it still shows;
  // the contributed entry is added after it rather than in place of it. Within
  // each source the order is that source's own.
  //
  // **One source failing must not silence the other.** Both used to share a
  // try, with the two calls evaluated as arguments to a single expression, so
  // whichever ran first could take the other down with it before it was ever
  // called — a master-side fault erasing every spoke-side badge, or the reverse.
  // They answer independent questions from independent tables; they fail
  // independently too, and each degrades on its own.
  const out = new Map<string, PaperProvenance[]>();
  for (const hook of ["pulledOrgByPmid", "receivedNodeByPmid"] as const) {
    for (const [pmid, entry] of askProvenance(mod, hook, pmids) ?? []) {
      const existing = out.get(pmid);
      if (existing) existing.push(entry);
      else out.set(pmid, [entry]);
    }
  }
  return out;
}

/**
 * One provenance source, contained — its entries, or null if it could not be
 * trusted to produce any.
 *
 * All-or-nothing per source. A hook that answers for six papers and then hands
 * back something unrecognisable has already told us its idea of the contract
 * differs from ours, and the six that parsed are no more credible than the one
 * that didn't; half a licensing answer is worse than none, because it reads as
 * a complete one.
 *
 * The guards below are not paranoia about our own code — they are about *whose*
 * code this is. `pro/` is a separate package with its own version, shipped as
 * its own image, and this file is the only contract between them. A Pro build
 * older than the interface it is being called through is a real deployment, not
 * a hypothetical:
 *
 *   - it may not have the method at all, which the type system cannot know
 *     because the type describes the interface, not the artefact on disk;
 *   - it may have it and return the *previous* shape. That one throws nothing.
 *     Before provenance was discriminated these hooks returned bare strings,
 *     and a try/catch cannot notice a call that succeeds and answers wrongly —
 *     the strings would have gone out on the wire and rendered as empty badges.
 *
 * So the shape is checked rather than assumed, and a mismatch degrades to the
 * free-tier answer like any other failure. A paying customer seeing no badge is
 * a bug; a paying customer seeing a *wrong* one, on the feature whose entire
 * purpose is licensing accuracy, is worse.
 */
function askProvenance(
  m: ProModule,
  hook: "pulledOrgByPmid" | "receivedNodeByPmid",
  pmids: string[]
): Array<[string, PaperProvenance]> | null {
  const fn = m[hook];
  // Logged, not silent: a Pro image that cannot answer half of what it is
  // being asked is exactly the case nobody would otherwise find out about.
  if (typeof fn !== "function") {
    console.warn(`[pro] provenance: this module has no ${hook}()`);
    return null;
  }
  try {
    const found = fn.call(m, pmids);
    const entries: Array<[string, PaperProvenance]> = [];
    for (const [pmid, entry] of found) {
      if (typeof pmid !== "string" || !isProvenance(entry)) {
        console.warn(`[pro] provenance: ${hook}() answered in a shape this build cannot read`);
        return null;
      }
      entries.push([pmid, entry]);
    }
    return entries;
  } catch (err) {
    // Once per /papers request while the module stays broken. Left unthrottled:
    // this is meant to be unreachable, and a log that repeats is how anyone
    // finds out it wasn't.
    console.warn(`[pro] provenance: ${hook}() failed: ${errMessage(err)}`);
    return null;
  }
}

/**
 * Whether a value is one this build knows how to render.
 *
 * Mirrors PaperProvenance in shared/types.ts, and has to be kept beside it: a
 * kind added there without a case here is dropped at the seam rather than
 * displayed. That is the safe direction to fail, but it is silent, so the union
 * is small on purpose.
 */
function isProvenance(v: unknown): v is PaperProvenance {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === "former-node") return true;
  if (kind !== "org" && kind !== "node") return false;
  return typeof (v as { label?: unknown }).label === "string";
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
    console.warn(`[pro] org check unavailable: ${errMessage(err)}`);
    return null;
  } finally {
    // The losing side of a race is never awaited, so an uncleared timer holds
    // an event-loop handle for its full duration after every successful check
    // — which in a test run is a process that will not exit.
    clearTimeout(timer);
  }
}

/**
 * Tell Pro that something may have created work to copy up. Does nothing in a
 * free build, which is why callers read as one line rather than a feature check.
 *
 * **Nothing here may reach the caller.** This is called from the tail of work
 * the user actually asked for — an import job that has already finished and
 * already written its rows — and a hint is only ever an optimisation over the
 * module's own interval. A throw escaping into that would fail an import that
 * fully succeeded, to speed up a sweep that was going to happen anyway.
 *
 * The missing-method case is separate from the throwing case for the reason
 * askProvenance spells out: a Pro image older than this interface is a real
 * deployment, not a hypothetical, and the type system cannot know what is on
 * disk. That one is logged once per hint and otherwise ignored — such a build
 * still sweeps on its interval, so the feature degrades to exactly what it was
 * before this hook existed.
 */
export function hintProSync(reason: string): void {
  if (!mod) return;
  if (typeof mod.syncHint !== "function") {
    console.warn("[pro] sync hint: this module has no syncHint()");
    return;
  }
  try {
    mod.syncHint(reason);
  } catch (err) {
    console.warn(`[pro] sync hint failed: ${errMessage(err)}`);
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
