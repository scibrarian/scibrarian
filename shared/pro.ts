// Wire shapes for the Pro tier, shared verbatim between server and client.
//
// These types live in the open repo on purpose: the *interface* is public, the
// implementation is not. Both halves of the split have to agree on what a Pro
// answer looks like, and the free build has to compile without the Pro module
// present — which it can, because every field below is optional or nullable and
// the free build simply never populates them.

/** What GET /auth reports about this instance's Pro module. `null` when free. */
export interface ProStatus {
  /** Module version, for support ("what are you running?"). */
  version: string;
  /**
   * This instance holds at least one paired node — it is acting as a master.
   * Derived from the node list rather than a role flag: an instance becomes a
   * master by having someone pair with it, and there is nothing to configure.
   */
  is_master: boolean;
  /** This instance is paired *to* a master. Both can be true. */
  is_paired: boolean;
  /** Number of currently active paired nodes. 0 on a pure spoke. */
  node_count: number;
}

/**
 * The third verdict on a /have line: the org holds this even though you don't.
 *
 * Deliberately thin. The master answers about the PMIDs it was asked about and
 * nothing else — never "here is what I hold" — because the index is itself
 * sensitive: what an agency is reading reveals which drugs and indications are
 * in play. `node` is the master's self-declared label, which authenticates
 * nothing and is only ever shown as a hint about where to ask.
 */
export interface OrgHolding {
  pmid: string;
  node: string;
}

// ---------- the Pro API's own wire shapes ----------
//
// Public because the client that renders them is public. Only the
// implementations behind /api/pro are closed.

/** One instance paired to this master. `name` is self-declared and authenticates nothing. */
export interface ProNode {
  id: number;
  name: string;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
  revoked_at: string | null;
  last_seen_at: string | null;
}

export interface ProNodesResponse {
  nodes: ProNode[];
  active: number;
  org_name: string;
}

/** Returned once, at mint time. The token behind it is never stored in the clear. */
export interface ProPairingMinted {
  code: string;
  node: ProNode;
}

/** Who this instance is paired *to*. Never carries the token. */
export interface ProMasterStatus {
  connected: boolean;
  url?: string;
  name?: string;
}

export interface ProPullResult {
  pmid: string;
  collection: string;
  file_name: string;
}
