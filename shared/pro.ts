// Wire shapes for the Pro tier, shared verbatim between server and client.
//
// These types live in the open repo on purpose: the *interface* is public, the
// implementation is not. Both halves of the split have to agree on what a Pro
// answer looks like, and the free build has to compile without the Pro module
// present — which it can, because every field below is optional or nullable and
// the free build simply never populates them.

/**
 * What GET /auth reports about this instance's Pro module.
 *
 * `null` in a free build **and to any caller who is not the owner** — /auth is
 * unauthenticated, and these fields describe the organization's topology rather
 * than the caller's own access. The two cases collapse on purpose: a viewer
 * cannot tell a Pro instance from a free one.
 */
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
 * What the API reports about the licence — deliberately never the key itself.
 *
 * A licence key is a credential. A Settings page that echoes it back is how one
 * gets copied to a second install, so the API answers with what an operator
 * needs to *see* and nothing they could re-enter elsewhere.
 */
export interface ProLicense {
  verdict: "valid" | "expired" | "invalid" | "absent";
  /** Customer name from the licence, so an operator can tell which one is loaded. */
  org: string;
  /** Seats the licence permits. 0 when there is no readable licence. */
  seats: number;
  /** ISO date, or null when nothing verified. */
  expires_at: string | null;
  /** Active paired nodes right now, for "7 of 10 seats in use". */
  nodes_in_use: number;
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
  /**
   * Files this node has fetched from the master, and sent up to it.
   *
   * `uploaded` counts transfers, not gifts: a writer who buys a paper on the
   * organisation's behalf and uploads it is counted the same as one donating
   * their own purchase, because who paid is procurement and the app never sees
   * it.
   *
   * Optional because absent and zero are different answers, and this row is
   * read by someone deciding whether a freelancer is pulling their weight.
   * Absent is "nothing recorded either way" — a node that paired this morning.
   * Zero is a measurement: this node appears in one table and not the other.
   * Both fields are sent together or not at all, so a reader can test either.
   */
  pulled?: number;
  uploaded?: number;
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
  /** This library's own address, as a remote spoke must reach it. */
  public_url: string;
  // Carried here rather than on ProStatus so the panel has one source of truth
  // that reload() refreshes. /auth is fetched once at page load, and a seat
  // count read from there would be wrong the moment a node is minted or
  // revoked — which is all this panel does.
  license: ProLicense;
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
  /**
   * When the master last refused this node — revoked, expired, or simply no
   * longer knowing it. Null while the pairing works.
   *
   * Reported because a spoke otherwise cannot tell: revocation takes effect on
   * the master instantly, and every path that meets the 401 swallows it so a
   * writer's local verdict survives an ordinary network blip.
   */
  rejected_at?: string | null;
}

/** A collection's organisation stamp. `active` means it syncs to the *current* pairing. */
export interface ProCollectionStamp {
  collection_id: number;
  master_url: string;
  org_name: string;
  since: string;
  active: boolean;
}

export interface ProSyncStatus {
  stamps: ProCollectionStamp[];
}

/** What one copy-up sweep did. */
export interface ProPushResult {
  sent: number;
  /** Already on the master, so recorded as done without transferring bytes. */
  skipped: number;
  /** Still outstanding — a first sync reports progress this way. */
  remaining: number;
  error?: string;
}

export interface ProPullResult {
  pmid: string;
  /**
   * The collections the copy was filed into — the ids the caller chose, echoed
   * back rather than resolved to names. The caller picked them from a list it
   * already holds, so names here would be a second lookup whose only use is to
   * be compared against what the client already knows.
   */
  collection_ids: number[];
  file_name: string;
}
