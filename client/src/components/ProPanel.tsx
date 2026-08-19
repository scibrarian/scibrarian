import { useEffect, useRef, useState, type FormEvent } from "react";
import { Copy, Check, KeyRound, Link2, TriangleAlert, Unlink } from "lucide-react";
import { ApiError, api } from "../api";
import { copyTextToClipboard } from "../lib/clipboard";
import { describeSweep, errorMessage } from "../lib/format";
import { Banner } from "./Banner";
import { ProPanelSkeleton } from "./Skeleton";
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

export function ProPanel({
  ready,
  onReady,
  desktop,
  onPairingChanged,
  onSharingChanged,
}: {
  /**
   * Whether Settings has decided the whole page may be drawn. False renders
   * this panel's stand-in, never a hollow version of the real thing — the
   * unpaired form used to paint on mount and be replaced a request later.
   */
  ready: boolean;
  /** Called once, when the first reload settles either way. See `ready`. */
  onReady: () => void;
  /**
   * Whether this instance is the desktop app, or null while the setting that
   * says so is still loading. Passed down rather than read here: it comes from
   * /api/settings, which Settings has already fetched, and a second request for
   * one boolean would answer at its own pace and give this panel a third load
   * state to be jumpy about.
   */
  desktop: boolean | null;
  onPairingChanged: () => void;
  /**
   * Reports the stamps this panel has just reloaded, so the Library's badge and
   * icon are redrawn from the read that already happened here. `null` when that
   * read is the one thing in the reload that failed, and the parent has to go
   * and ask for itself.
   */
  onSharingChanged: (stamps: ProCollectionStamp[] | null) => void;
}) {
  const [nodes, setNodes] = useState<ProNode[]>([]);
  const [orgName, setOrgName] = useState("");
  const [master, setMaster] = useState<ProMasterStatus>({ connected: false });
  const [license, setLicense] = useState<ProLicense | null>(null);
  // Which collections belong to which organisation, and the collections
  // themselves so a stamp can be shown against a name.
  const [stamps, setStamps] = useState<ProCollectionStamp[]>([]);
  // The same list, readable the instant reload() returns. State is not — it
  // settles a render later — and the parent is told about a share inside the
  // click that caused it, so this is what gets handed over. Null until a read
  // of them succeeds, which is exactly the case the parent must not be handed.
  const lastStamps = useRef<ProCollectionStamp[] | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [licenseKey, setLicenseKey] = useState("");
  // A license refused for being shorter than the one already saved.
  //
  // Held apart from `error` because it is not a failure — it is a question. The
  // banner reports things that went wrong and clears on the next action; this
  // has to survive long enough for the operator to answer it, and carries the
  // answer beside it. Cleared when the box is edited, since a new key makes the
  // old refusal moot.
  const [licenseConflict, setLicenseConflict] = useState<string | null>(null);
  // The last sweep's counts, so "Sync now" reports something rather than
  // appearing to do nothing when everything is already up to date.
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  // Whether the sweep specifically is in flight, which `busy` cannot say — that
  // is set by every action here, and only this one has progress to report.
  //
  // Load-bearing for the layout as much as for the label. run() clears syncMsg
  // on the way in, so the result line used to vanish on click and come back
  // when the sweep landed: a 32px shrink and re-grow, measured, with the rest
  // of Settings moving under it both times. This keeps one line on screen
  // throughout by putting "Syncing…" in the same element the answer will fill.
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The pairing code, held only until the operator navigates away. It is
  // returned once and never stored, so this is the single moment it can be
  // copied — the panel says so rather than letting someone discover it later.
  const [minted, setMinted] = useState<{ code: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [newNodeName, setNewNodeName] = useState("");
  // This library's own public address — a stored setting, not a per-code field.
  //
  // Two values because the box is editable and the setting is not: `publicUrl`
  // is what is on screen, `savedPublicUrl` what the server last confirmed it
  // holds. Every save compares them, so tabbing through the field without
  // typing sends nothing — see savePublicUrl.
  const [publicUrl, setPublicUrl] = useState("");
  const [savedPublicUrl, setSavedPublicUrl] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);

  // Settled, not all-or-nothing. These four answer independently and only the
  // first is load-bearing: the sync stamps are read inside the `connected`
  // branch alone, so on a master-only instance — or against a Pro module built
  // before /api/pro/sync existed — that request 404s while /api/pro/nodes
  // answers perfectly well. Under Promise.all the first rejection discarded the
  // other three, and the license, the node list and the mint form all rendered
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
      // Both, always. Without the first the box renders empty on every visit
      // after the one where it was typed, which reads as "no address is set" —
      // and the mint button, which is gated on it, stays disabled against a
      // server that holds a perfectly good one.
      setPublicUrl(n.value.public_url);
      setSavedPublicUrl(n.value.public_url);
      setLicense(n.value.license);
    }
    if (m.status === "fulfilled") setMaster(m.value);
    // Cleared on a failure rather than left holding the previous answer, which
    // is the one the share just invalidated: handing that up would redraw the
    // Library's badge exactly as it was before the click.
    lastStamps.current = sy.status === "fulfilled" ? sy.value.stamps : null;
    if (sy.status === "fulfilled") setStamps(sy.value.stamps);
    if (cs.status === "fulfilled") setCollections(cs.value);
    // Reports a failure but never clears one: run() has already cleared the
    // banner for this action, and a sweep that came back with an error of its
    // own sets it *before* this runs.
    const failed = [n, m, sy, cs].find((r) => r.status === "rejected");
    if (failed) setError(errorMessage(failed.reason));
  }

  useEffect(() => {
    // Reported on settle, not on success: reload() is built on allSettled and
    // resolves whatever answered, so a master that 404s still leaves this panel
    // with everything it is going to get. Waiting for a clean run would hold
    // the whole Settings page skeletal behind one unreachable endpoint.
    void reload().then(onReady);
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

  // Both ways in — the ordinary save and the deliberate replace — so the
  // clearing that has to follow a success is written once. Throws on to run(),
  // which is what puts an ordinary failure in the banner.
  async function saveLicense(replace: boolean) {
    await api.proSetLicense(licenseKey.trim(), replace);
    setLicenseKey("");
    setLicenseConflict(null);
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
    // Set before run(), which is what makes the swap seamless: both this and
    // run()'s setSyncMsg(null) happen in one synchronous block, so React
    // batches them into a single render and the line goes straight from the
    // last result to "Syncing…" without a blank frame in between.
    //
    // Cleared in a finally, after run() has already settled and written the new
    // message — so the line changes from "Syncing…" to the answer, never to
    // nothing and back.
    setSyncing(true);
    try {
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
    } finally {
      setSyncing(false);
    }
  }

  // The address. Reports whether it actually wrote, and throws like the call it
  // wraps — so each caller below decides what a refusal means.
  //
  // Nothing is sent when it hasn't changed. Blur fires on tabbing past the
  // field, on clicking anywhere else in the panel, on switching windows; with
  // an unconditional PUT any of those sent whatever the box happened to
  // contain, and an empty box — the state every visit began in until reload()
  // started hydrating it — erased a working address.
  async function savePublicUrl(): Promise<boolean> {
    const next = publicUrl.trim();
    if (next === savedPublicUrl) return false;
    const res = await api.proSetPublicUrl(next);
    // Set from the answer, not from what was typed: the server strips a
    // trailing slash, so echoing the input back would leave the box differing
    // from the stored value and every later blur saving again.
    setPublicUrl(res.public_url);
    setSavedPublicUrl(res.public_url);
    return true;
  }

  // Blur is not an action, so this deliberately isn't run(): run() sets `busy`,
  // and the mint button is disabled on it. A click on "Create code" blurs this
  // field first (mousedown, blur, mouseup, click), so a save that flipped
  // `busy` synchronously left the button disabled by the time the click landed
  // — and a disabled button dispatches nothing, so the operator's first press
  // did nothing at all. It reports failure and never reloads: a refused address
  // has to stay in the box, where it can be corrected.
  async function savePublicUrlOnBlur(): Promise<void> {
    try {
      if (await savePublicUrl()) setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function mint(e: FormEvent) {
    e.preventDefault();
    if (!newNodeName.trim()) return;
    await run(async () => {
      // The address on screen is the one the code must be built from, so it is
      // committed here rather than trusted to have been. Submitting with Enter
      // never blurs the field, and the blur save isn't awaited when it does
      // happen — this is the only point where the ordering is guaranteed. A
      // no-op when the value is already stored, and a throw when it is refused,
      // which stops the mint and skips run()'s reload — the reload would
      // replace the rejected text with the stored address and leave a banner
      // about a URL no longer on screen.
      await savePublicUrl();
      const res = await api.proMintNode(newNodeName.trim());
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
  // The connection is on record as over. Everything the spoke side does needs a
  // master that still answers, so the actions come down with the status line —
  // otherwise the panel says "Lookups and copies have stopped" directly above a
  // "Sync now" button, and clicking it out of hope replaces that sentence with
  // a raw "master answered 401". Disconnect stays: it is the one action here
  // that still means something.
  const ended = master.connected && Boolean(master.rejected_at);

  const nodeState = (n: ProNode): "revoked" | "expired" | "pending" | "active" => {
    if (n.revoked_at) return "revoked";
    if (new Date(n.expires_at) <= new Date()) return "expired";
    return n.confirmed_at == null ? "pending" : "active";
  };

  // After every hook, so the hook order is the same on both paths — and after
  // the effect above, which is what eventually makes this false.
  if (!ready) return <ProPanelSkeleton master={desktop === false} />;

  return (
    <section className="panel pro-panel">
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
          {master.rejected_at ? (
            /* The panel used to keep saying "Connected" indefinitely after a
               master revoked this node: the check is a live lookup there, and
               every path that meets the 401 here swallows it by design. Now the
               first refused request records it and this says so. */
            <p className="pro-rejected">
              <Unlink size={14} className="inline-icon" aria-hidden />
              <span>
                <strong>{master.name}</strong> has ended this connection
                {` (${master.rejected_at.slice(0, 10)})`}. Lookups and
                copies have stopped. Papers already here stay in your library — ask them for a
                new pairing code to reconnect.
              </span>
            </p>
          ) : (
            <p>
              <Link2 size={14} className="inline-icon" aria-hidden /> Connected to{" "}
              <strong>{master.name}</strong> <span className="hint">({master.url})</span>
            </p>
          )}
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
              anything — but not once the master has ended the connection, when
              stamping a collection against a pairing that is over would record
              a boundary with nobody on the other side of it. */}
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
                    {/* Three reasons a row is not syncing and only one of them
                        is "some other organisation" — saying that of the org
                        named right above, whose connection has merely ended,
                        was the reading `ended` was added to prevent. */}
                    <span className="hint">
                      {shared
                        ? `shared with ${stamp!.org_name}`
                        : stamp?.ended
                          ? `${stamp.org_name} (connection ended)`
                          : stamp
                            ? `${stamp.org_name} (not your current organization)`
                            : "local"}
                    </span>
                    <button
                      type="button"
                      disabled={busy || ended}
                      onClick={() =>
                        void run(() =>
                          shared ? api.proUnshareCollection(c.id) : api.proShareCollection(c.id)
                        ).then((ok) => {
                          // Only on success, and only the stamps: the Library's
                          // icon and badge are drawn from them, and this panel
                          // is the one place they change without a collection
                          // being created or a pairing moving.
                          //
                          // run() has already reloaded them, so what goes up is
                          // that answer rather than a signal to fetch it again.
                          if (ok) onSharingChanged(lastStamps.current);
                        })
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
            {/* Spinner and label both, the way .refresh-btn does it. `busy`
                alone only reached `disabled`, so a sweep over a slow link was
                a button that had stopped responding and nothing else — the
                work was invisible until the counts landed. */}
            <button type="button" disabled={busy || ended} onClick={() => void syncNow()}>
              {syncing && <span className="btn-spinner" aria-hidden="true" />}
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
          {/* One line either way: the progress and the answer share an element,
              so the panel keeps its height across the whole sweep rather than
              losing a row on click and regaining it on completion.

              role="status" is worth having only because of that — a live region
              announces a *change* to content it was already showing, and this
              one is now on screen before the result replaces "Syncing…". */}
          {(syncing || syncMsg) && (
            <p className="hint" role="status">
              {syncing ? "Syncing…" : syncMsg}
            </p>
          )}
          <p className="hint">
            {ended
              ? `Sharing can't be changed while ${master.name} has this connection ended — reconnect with a new pairing code first. Papers already sent to them stay there.`
              : `Stopping sharing affects future copies only — papers already sent to ${master.name} stay there.`}
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

      {/* The master half: minting pairing codes so other people's instances
          can connect to this one. Absent in the desktop build, which binds to
          loopback and has no address reachable from outside the machine — every
          code it minted would point somewhere nobody else can get to, and the
          address field the mint form is gated on has nothing valid to hold.

          `desktop === false`, not `!desktop`: the flag arrives with the settings,
          a request later than this panel's first paint, and null means "not known
          yet". Showing this and then taking it away is the worse direction —
          it is a section an operator may already have started reading. */}
      {desktop === false && (
        <>
          {/* ---- master side: who is connected to this instance ---- */}
          <h4>People connected to this library</h4>
          <p className="hint">
            Run this on the machine that holds your organization&rsquo;s library, then send a pairing
            code to each writer. Each code is for one person and expires on its own.
          </p>

          {/* The license. Shown before the mint form because it is what decides
              whether minting will work — finding that out from a 402 after typing
              someone's name is the wrong order. */}
          <LicenseRow license={license} />
          <form
            className="pro-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                try {
                  await saveLicense(false);
                } catch (err) {
                  // The one refusal with an answer. Caught rather than thrown on,
                  // so run() leaves the banner alone and the panel asks instead.
                  if (err instanceof ApiError && err.status === 409) {
                    setLicenseConflict(err.message);
                    return;
                  }
                  throw err;
                }
              });
            }}
          >
            <div className="pro-row">
              <input
                value={licenseKey}
                onChange={(e) => {
                  setLicenseKey(e.target.value);
                  setLicenseConflict(null);
                }}
                placeholder={license?.verdict === "valid" ? "Replace license key" : "License key"}
                spellCheck={false}
              />
              <button type="submit" disabled={busy || !licenseKey.trim()}>
                Save license
              </button>
            </div>
            {licenseConflict && (
              <p className="pro-license bad">
                <TriangleAlert size={14} className="inline-icon" aria-hidden />
                <span>
                  {licenseConflict}{" "}
                  <button
                    type="button"
                    className="pro-license-answer"
                    disabled={busy || !licenseKey.trim()}
                    onClick={() => void run(() => saveLicense(true))}
                  >
                    Replace anyway
                  </button>
                </span>
              </p>
            )}
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

          {/* Entered once. Every pairing code is built from it, so a typo here is a
              typo in all of them — and it surfaces on someone else's machine, days
              later, as a code that simply will not connect. */}
          <div className="pro-row">
            <input
              value={publicUrl}
              onChange={(e) => setPublicUrl(e.target.value)}
              placeholder="https://library.youragency.com"
              spellCheck={false}
              onBlur={() => void savePublicUrlOnBlur()}
            />
          </div>
          <p className="hint">
            This library&rsquo;s address, as writers reach it from outside your network. Every code
            you create points here.
          </p>

          <form className="pro-form" onSubmit={mint}>
            <div className="pro-row">
              <input
                value={newNodeName}
                onChange={(e) => setNewNodeName(e.target.value)}
                placeholder="Who is this for? e.g. Dana (freelancer)"
              />
              <button
                type="submit"
                className="primary"
                disabled={busy || !newNodeName.trim() || !publicUrl.trim()}
              >
                Create code
              </button>
            </div>
            {!publicUrl.trim() && (
              <p className="hint">Set the address above before creating codes.</p>
            )}
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
                        them, sends neither. `?? 0` printed "pulled 0 · uploaded 0"
                        against every writer at once — turning "not measured" into
                        exactly the accusation this row exists to raise. */}
                    {(n.pulled !== undefined || n.uploaded !== undefined) && (
                      <span className="hint">
                        pulled {n.pulled ?? 0} · uploaded {n.uploaded ?? 0}
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
        </>
      )}
    </section>
  );
}

// The license, as a single line an operator can act on.
//
// Every state names what to do next rather than only what is wrong: an expired
// license says existing connections keep working, because the first question a
// Scientific Director asks on seeing "expired" is whether their writers just
// lost access. They didn't — the gate only refuses *new* pairings — and saying
// so here is cheaper than fielding the call.
function LicenseRow({ license }: { license: ProLicense | null }) {
  if (!license) return null;

  if (license.verdict === "absent") {
    return (
      <p className="pro-license absent">
        <KeyRound size={14} className="inline-icon" aria-hidden />
        No license yet. Writers can&rsquo;t be connected until one is added.
      </p>
    );
  }

  if (license.verdict === "invalid") {
    return (
      <p className="pro-license bad">
        <TriangleAlert size={14} className="inline-icon" aria-hidden />
        This license key isn&rsquo;t valid. Check it was pasted in full, or ask for a new one.
      </p>
    );
  }

  // Null for a perpetual or site license — "ISO date, or null when nothing
  // verified". Both branches below drop the date clause rather than
  // interpolating an empty string into it, which read as "expired on ." and
  // "seats in use, until .".
  const on = license.expires_at?.slice(0, 10) ?? "";

  if (license.verdict === "expired") {
    return (
      <p className="pro-license bad">
        <TriangleAlert size={14} className="inline-icon" aria-hidden />
        <span>
          License for <strong>{license.org}</strong> {on ? `expired on ${on}` : "has expired"}.
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
