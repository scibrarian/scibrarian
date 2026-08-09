import { useEffect, useState, type FormEvent } from "react";
import { Copy, Check, Link2, Unlink } from "lucide-react";
import { api } from "../api";
import { copyTextToClipboard } from "../lib/clipboard";
import { errorMessage } from "../lib/format";
import { Banner } from "./Banner";
import type { ProMasterStatus, ProNode } from "../types";

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
// Takes no props. The /auth block gates whether Settings renders this at all,
// but it is fetched once at page load and never refreshed, so anything read
// from it here would go stale the moment the operator mints or revokes
// something — which is the only thing this panel does. Everything on screen is
// derived from the node list, which reload() refreshes after every mutation.

export function ProPanel() {
  const [nodes, setNodes] = useState<ProNode[]>([]);
  const [orgName, setOrgName] = useState("");
  const [master, setMaster] = useState<ProMasterStatus>({ connected: false });
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

  async function reload() {
    try {
      const [n, m] = await Promise.all([api.proNodes(), api.proMaster()]);
      setNodes(n.nodes);
      setOrgName(n.org_name);
      setMaster(m);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
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
          <button type="button" disabled={busy} onClick={() => void run(api.proDisconnect)}>
            <Unlink size={14} className="inline-icon" aria-hidden /> Disconnect
          </button>
          <p className="hint">
            Disconnecting stops future lookups and copies. Papers already copied here stay in
            your library.
          </p>
        </div>
      ) : (
        <form
          className="pro-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pairingCode.trim()) return;
            void run(async () => {
              await api.proConnect(pairingCode.trim());
              setPairingCode("");
            });
          }}
        >
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
