import { useEffect, useState, type FormEvent } from "react";
import { Copy, Check, KeyRound, Link2, TriangleAlert, Unlink } from "lucide-react";
import { api } from "../api";
import { copyTextToClipboard } from "../lib/clipboard";
import { describeSweep, errorMessage } from "../lib/format";
import { Banner } from "./Banner";
import type {
  Collection,
  ProCollectionStamp,
  ProLicense,
  ProMasterStatus,
  ProNode,
} from "../types";

// Shared holdings — the Settings panel for the Pro tier.
//
// Public, like the rest of the client: only the implementations behind
// /api/pro are closed. Rendered when GET /auth reports a `pro` block, which is
// null in a free build, so nothing here is ever reachable there.
//
// One instance can be both ends at once and the panel says so plainly, because
// there is no role to configure: this instance is a *master* if anything paired
// with it, and a *spoke* if it paired with something. Both halves are shown to
// whoever holds the admin token — which is the person who runs this instance,
// not an account with a tier.
//
// Reads nothing from the /auth block. That block gates whether Settings renders
// this at all, but it is fetched once at page load, so anything read from it
// here would go stale the moment the operator mints or revokes something —
// which is the only thing this panel does. Everything on screen is derived from
// the node list, which reload() refreshes after every mutation.
//
// It reports *upward* for the same reason. Connecting and disconnecting change
// `is_paired`, and that flag is read outside this panel — it decides whether a
// new collection is offered to the organization at the moment it is created.
// Refreshing only what is on screen would leave the rest of the app acting on
// the pairing that was live when the page loaded: pair, make the collection you
// paired *for*, and it is silently kept local. So the one thing this panel
// cannot derive locally is announced instead.

export function ProPanel({ onPairingChanged }: { onPairingChanged: () => void }) {
  const [nodes, setNodes] = useState<ProNode[]>([]);
  const [orgName, setOrgName] = useState("");
  const [master, setMaster] = useState<ProMasterStatus>({ connected: false });
  const [license, setLicense] = useState<ProLicense | null>(null);
  // Which collections belong to which organisation, and the collections
  // themselves so a stamp can be shown against a name.
  const [stamps, setStamps] = useState<ProCollectionStamp[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [licenseKey, setLicenseKey] = useState("");
  // The last sweep's counts, so "Sync now" reports something rather than
  // appearing to do nothing when everything is already up to date.
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The pairing code, held only until the operator navigates away. It is
  // returned once and never stored, so this is the single moment it can be
  // copied — the panel says so rather than letting someone discover it later.
  const [minted, setMinted] = useState<{ code: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [newNodeName, setNewNodeName] = useState("");
  const [masterUrl, setMasterUrl] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);

  // Settled, not all-or-nothing. These four answer independently and only the
  // first is load-bearing: the sync stamps are read inside the `connected`
  // branch alone, so on a master-only instance — or against a Pro module built
  // before /api/pro/sync existed — that request 404s while /api/pro/nodes
  // answers perfectly well. Under Promise.all the first rejection discarded the
  // other three, and the licence, the node list and the mint form all rendered
  // empty behind one banner. Whatever arrived is shown; what didn't is reported.
  async function reload() {
    const [n, m, sy, cs] = await Promise.allSettled([
      api.proNodes(),
      api.proMaster(),
      api.proSync(),
      api.getCollections(),
    ]);
    if (n.status === "fulfilled") {
      setNodes(n.value.nodes);
      setOrgName(n.value.org_name);
      setLicense(n.value.license);
    }
    if (m.status === "fulfilled") setMaster(m.value);
    if (sy.status === "fulfilled") setStamps(sy.value.stamps);
    if (cs.status === "fulfilled") setCollections(cs.value);
    // Reports a failure but never clears one: run() has already cleared the
    // banner for this action, and a sweep that came back with an error of its
    // own sets it *before* this runs.
    const failed = [n, m, sy, cs].find((r) => r.status === "rejected");
    if (failed) setError(errorMessage(failed.reason));
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Returns whether the action itself succeeded, for the two callers that have
  // to tell the rest of the app. A failed reload() afterwards doesn't make it
  // false — reload reports its own trouble, and the pairing changed either way.
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    // Any action here invalidates the last sweep's report. Without this, "Copied
    // 3 up." sat under a red banner from the *next* click as though the sweep
    // had just succeeded, and survived Share, Stop sharing, Revoke and
    // Disconnect besides.
    setSyncMsg(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // The two that change `is_paired`. Minting and revoking don't: they make this
  // instance a master, which nothing outside the panel branches on.
  async function connect(e: FormEvent) {
    e.preventDefault();
    if (!pairingCode.trim()) return;
    const ok = await run(async () => {
      await api.proConnect(pairingCode.trim());
      setPairingCode("");
    });
    if (ok) onPairingChanged();
  }

  async function disconnect() {
    if (await run(api.proDisconnect)) onPairingChanged();
  }

  async function syncNow() {
    await run(async () => {
      const r = await api.proRunSync();
      // Counts first, and always. A sweep that stopped part way still moved
      // files, and "3 of 12 went, then the master refused" is a different
      // situation from "nothing went" — the old code showed the error text
      // alone and threw the progress away.
      setSyncMsg(describeSweep(r));
      // The endpoint reports trouble in a field rather than by rejecting, so
      // this is set here rather than left to run()'s catch. It goes to the
      // banner because it is a failure: rendered as a .hint it was styled
      // identically to the success line directly above it.
      if (r.error) setError(r.error);
    });
  }

  async function mint(e: FormEvent) {
    e.preventDefault();
    if (!newNodeName.trim() || !masterUrl.trim()) return;
    await run(async () => {
      const res = await api.proMintNode(newNodeName.trim(), masterUrl.trim());
      setMinted({ code: res.code, name: res.node.name });
      setCopied(false);
      setNewNodeName("");
    });
  }

  // One derivation, read by both the row's styling and its label. Those used to
  // be two independent ladders, and they disagreed: a code minted a moment ago
  // has no confirmed_at, which the old predicate read as not-live, so the row
  // rendered struck through as history directly above its own label saying
  // "code not used yet" — the operator looking at the code they had just
  // created, presented as dead.
  //
  // Only revoked and expired rows are history, which is what the stylesheet
  // says .inactive means. A pending one is the most live thing on this panel:
  // it is the code the operator is about to send someone.
  const nodeState = (n: ProNode): "revoked" | "expired" | "pending" | "active" => {
    if (n.revoked_at) return "revoked";
    if (new Date(n.expires_at) <= new Date()) return "expired";
    return n.confirmed_at == null ? "pending" : "active";
  };

  return (
    <section className="panel">
      <h3>Shared holdings</h3>
      <p className="hint">
        Connect this library to your organization&rsquo;s, so a paper someone has already bought
        doesn&rsquo;t get bought again. Papers are copied between instances you pair — nothing is
        sent anywhere else.
      </p>

      {error && <Banner kind="error" message={error} onDismiss={() => setError(null)} />}

      {/* ---- spoke side: who this instance is connected to ---- */}
      <h4>Your organization</h4>
      {master.connected ? (
        <div className="pro-connected">
          <p>
            <Link2 size={14} className="inline-icon" aria-hidden /> Connected to{" "}
            <strong>{master.name}</strong> <span className="hint">({master.url})</span>
          </p>
          <button type="button" disabled={busy} onClick={() => void disconnect()}>
            <Unlink size={14} className="inline-icon" aria-hidden /> Disconnect
          </button>
          <p className="hint">
            Disconnecting stops future lookups and copies. Papers already copied here stay in
            your library.
          </p>

          {/* The engagement boundary, one row per collection.
              
              Stamped when a collection is created, from whatever pairing was
              live then — so this list is normally something to read rather than
              something to operate. It stays editable because a stamp can be
              wrong, and because un-sharing has to be possible without deleting
              anything. */}
          <h5>Collections</h5>
          {collections.length === 0 ? (
            <p className="hint">No collections yet.</p>
          ) : (
            <ul className="pro-collections">
              {collections.map((c) => {
                const stamp = stamps.find((s) => s.collection_id === c.id);
                const shared = stamp?.active === true;
                return (
                  <li key={c.id}>
                    <span className="pro-collection-name">{c.name}</span>
                    <span className="hint">
                      {shared
                        ? `shared with ${stamp!.org_name}`
                        : stamp
                          ? `${stamp.org_name} (not your current organization)`
                          : "local"}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          shared ? api.proUnshareCollection(c.id) : api.proShareCollection(c.id)
                        )
                      }
                    >
                      {shared ? "Stop sharing" : `Share with ${master.name}`}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="pro-row">
            <button type="button" disabled={busy} onClick={() => void syncNow()}>
              Sync now
            </button>
          </div>
          {syncMsg && <p className="hint">{syncMsg}</p>}
          <p className="hint">
            Stopping sharing affects future copies only — papers already sent to {master.name}{" "}
            stay there.
          </p>
        </div>
      ) : (
        <form className="pro-form" onSubmit={(e) => void connect(e)}>
          <label htmlFor="pro-code" className="hint">
            Paste the pairing code your organization sent you.
          </label>
          <div className="pro-row">
            <input
              id="pro-code"
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value)}
              placeholder="Pairing code"
              spellCheck={false}
            />
            <button type="submit" className="primary" disabled={busy || !pairingCode.trim()}>
              Connect
            </button>
          </div>
        </form>
      )}

      {/* ---- master side: who is connected to this instance ---- */}
      <h4>People connected to this library</h4>
      <p className="hint">
        Run this on the machine that holds your organization&rsquo;s library, then send a pairing
        code to each writer. Each code is for one person and expires on its own.
      </p>

      {/* The licence. Shown before the mint form because it is what decides
          whether minting will work — finding that out from a 402 after typing
          someone's name is the wrong order. */}
      <LicenseRow license={license} />
      <form
        className="pro-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.proSetLicense(licenseKey.trim());
            setLicenseKey("");
          });
        }}
      >
        <div className="pro-row">
          <input
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder={license?.verdict === "valid" ? "Replace licence key" : "Licence key"}
            spellCheck={false}
          />
          <button type="submit" disabled={busy || !licenseKey.trim()}>
            Save licence
          </button>
        </div>
        <p className="hint">
          Entered once per organization. It is checked on this machine and never sent anywhere.
        </p>
      </form>

      <div className="pro-row">
        <input
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          placeholder="Organization name (shown to connected writers)"
          onBlur={() => void run(() => api.proSetOrgName(orgName))}
        />
      </div>

      <form className="pro-form" onSubmit={mint}>
        <div className="pro-row">
          <input
            value={newNodeName}
            onChange={(e) => setNewNodeName(e.target.value)}
            placeholder="Who is this for? e.g. Dana (freelancer)"
          />
          <input
            value={masterUrl}
            onChange={(e) => setMasterUrl(e.target.value)}
            placeholder="https://library.youragency.com"
            spellCheck={false}
          />
          <button
            type="submit"
            className="primary"
            disabled={busy || !newNodeName.trim() || !masterUrl.trim()}
          >
            Create code
          </button>
        </div>
        <p className="hint">
          The address has to be one they can reach from outside your network.
        </p>
      </form>

      {minted && (
        <div className="pro-minted">
          <p>
            Pairing code for <strong>{minted.name}</strong> — copy it now, it isn&rsquo;t shown
            again.
          </p>
          <div className="pro-row">
            <code className="pro-code">{minted.code}</code>
            <button
              type="button"
              onClick={() => {
                void copyTextToClipboard(minted.code);
                setCopied(true);
              }}
            >
              {copied ? (
                <>
                  <Check size={14} className="inline-icon" aria-hidden /> Copied
                </>
              ) : (
                <>
                  <Copy size={14} className="inline-icon" aria-hidden /> Copy
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {nodes.length === 0 ? (
        <p className="hint">Nobody is connected yet.</p>
      ) : (
        <ul className="pro-nodes">
          {nodes.map((n) => {
            const state = nodeState(n);
            return (
              <li key={n.id} className={state === "revoked" || state === "expired" ? "inactive" : ""}>
                <span className="pro-node-name">{n.name}</span>
                {/* Taken and given. No gate hangs off this — it is here so the
                    person who approves purchases can see a writer who pulls a
                    lot and shares nothing, and ask.

                    Both fields are optional, and absent is not zero: a build
                    that doesn't record these counters, or a node row predating
                    them, sends neither. `?? 0` printed "pulled 0 · shared 0"
                    against every writer at once — turning "not measured" into
                    exactly the accusation this row exists to raise. */}
                {(n.pulled !== undefined || n.shared !== undefined) && (
                  <span className="hint">
                    pulled {n.pulled ?? 0} · shared {n.shared ?? 0}
                  </span>
                )}
                <span className="hint">
                  {state === "revoked"
                    ? "revoked"
                    : state === "expired"
                      ? "expired"
                      : state === "pending"
                        ? "code not used yet"
                        : `expires ${n.expires_at.slice(0, 10)}`}
                </span>
                {!n.revoked_at && (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void run(() => api.proRevokeNode(n.id))}
                  >
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Shown exactly when a Revoke button is on screen. This used to read
          pro.node_count — a number from the /auth call made once at page load
          and never refreshed, while the list beside it reloads after every mint
          and revoke. On a fresh master, pairing the first writer left this
          hidden with a live node listed above it; revoking the last one left it
          showing. The loaded list is the answer already in hand. */}
      {nodes.some((n) => !n.revoked_at) && (
        <p className="hint">
          Revoking stops future lookups and copies. It cannot take back anything already copied
          to someone&rsquo;s machine.
        </p>
      )}
    </section>
  );
}

// The licence, as a single line an operator can act on.
//
// Every state names what to do next rather than only what is wrong: an expired
// licence says existing connections keep working, because the first question a
// Scientific Director asks on seeing "expired" is whether their writers just
// lost access. They didn't — the gate only refuses *new* pairings — and saying
// so here is cheaper than fielding the call.
function LicenseRow({ license }: { license: ProLicense | null }) {
  if (!license) return null;

  if (license.verdict === "absent") {
    return (
      <p className="pro-license absent">
        <KeyRound size={14} className="inline-icon" aria-hidden />
        No licence yet. Writers can&rsquo;t be connected until one is added.
      </p>
    );
  }

  if (license.verdict === "invalid") {
    return (
      <p className="pro-license bad">
        <TriangleAlert size={14} className="inline-icon" aria-hidden />
        This licence key isn&rsquo;t valid. Check it was pasted in full, or ask for a new one.
      </p>
    );
  }

  // Null for a perpetual or site licence — "ISO date, or null when nothing
  // verified". Both branches below drop the date clause rather than
  // interpolating an empty string into it, which read as "expired on ." and
  // "seats in use, until .".
  const on = license.expires_at?.slice(0, 10) ?? "";

  if (license.verdict === "expired") {
    return (
      <p className="pro-license bad">
        <TriangleAlert size={14} className="inline-icon" aria-hidden />
        <span>
          Licence for <strong>{license.org}</strong> {on ? `expired on ${on}` : "has expired"}.
          Existing connections keep working — renew to connect anyone new.
        </span>
      </p>
    );
  }

  // Valid. The seat count reads as a fraction because the number that matters
  // is how many are left, and "7 of 10" answers that without arithmetic.
  const full = license.nodes_in_use >= license.seats;
  return (
    <p className={`pro-license ${full ? "bad" : "ok"}`}>
      <KeyRound size={14} className="inline-icon" aria-hidden />
      <span>
        Licensed to <strong>{license.org}</strong> — {license.nodes_in_use} of {license.seats}{" "}
        seats in use{on ? `, until ${on}` : ""}.
        {full && " Revoke a connection, or upgrade, to connect anyone new."}
      </span>
    </p>
  );
}
