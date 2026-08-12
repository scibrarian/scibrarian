import { useState, type FormEvent } from "react";
import { Check, ExternalLink, FileText, Minus, TriangleAlert, Users } from "lucide-react";
import { api } from "../api";
import { errorMessage, formatAuthors, titleCaseJournal } from "../lib/format";
import { usePaperOpener, type PaperAccess } from "../lib/openPaper";
import { MAX_HAVE_REFS } from "../../../shared/limits";
import type { Collection, HaveAnswer, HaveMatch, HaveResponse, ParsedRefView } from "../types";
import { Banner } from "./Banner";
import { ModalShell } from "./Dialogs";

// What this feature is called wherever it is named: the header button, that
// button's loading stand-in (which is sized from this text, so a rename that
// missed it would leave the stand-in holding the old width), and the modal's
// own title. It has been renamed once already — see commit 88626cf.
export const HAVE_CHECK_TITLE = "Check references";

// "Check references" — the check a writer is required to run before asking a
// project manager to approve buying an article.
//
// It answers on identifiers only: a PMID, a DOI, or a PubMed link, alone on the
// line or buried in a full reference. A line carrying none is reported as such
// rather than guessed at from its author and year — see citation-ref.ts for why
// that guess was removed.
//
// Answers keep the input's order and there is always exactly one per line, so a
// pasted reference list can be read straight down beside the original.

const PLACEHOLDER = `10.1056/NEJMoa2035389
PMID: 33301246
https://pubmed.ncbi.nlm.nih.gov/33301246/`;

export function HaveCheck({
  open,
  onClose,
  access,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  access: PaperAccess;
  /**
   * This modal wrote to the library — a copy was filed, or a collection was
   * created to hold one. Reported upward because neither is visible from here:
   * the sidebar, the source picker and the collection views are the shell's,
   * and nothing else tells it a check modal just added to them.
   */
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [response, setResponse] = useState<HaveResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which row is mid-copy, by index. One at a time: each pull moves a whole
  // PDF, and a list of simultaneous transfers is neither useful nor readable.
  const [pulling, setPulling] = useState<number | null>(null);
  // Which row has its destination picker open, by index. One at a time, like
  // the transfers themselves.
  const [choosing, setChoosing] = useState<number | null>(null);
  // The collections a copy may be filed into: those shared with the
  // organisation paired right now. Loaded after a check that turned up an org
  // hit rather than when the modal opens — these endpoints don't exist in a
  // free build, and a check with nothing held by the org never shows a picker.
  const [destinations, setDestinations] = useState<Collection[]>([]);
  // Why the list is empty, when it is empty for a reason other than "nothing is
  // shared". Kept apart from `error` so a failure to load destinations never
  // banners over a reference check that succeeded.
  const [destError, setDestError] = useState<string | null>(null);
  const { openPaper, openError, clearOpenError } = usePaperOpener(access);

  // Split here as well as on the server so the button can say how many
  // references are about to be checked, and so a paste past the cap is reported
  // before the request rather than after it.
  const refs = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  async function check(e: FormEvent) {
    e.preventDefault();
    if (refs.length === 0) return;
    setChecking(true);
    setError(null);
    try {
      const answers = await api.checkHave(refs);
      setResponse(answers);
      setChoosing(null);
      // Only when there is something to copy and someone able to copy it.
      if (access.isAdmin && answers.results.some((r) => !r.held && r.org)) {
        // Deliberately outside this try. The check has already succeeded and
        // its answers are on screen; a destination list that failed to load is
        // a problem with the *next* action, not with the one just completed.
        // Awaited inside it, a transient 5xx here put a red banner over a
        // perfectly good result list.
        void loadDestinations();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  // Where a copy is allowed to land: collections shared with the organisation
  // paired *now*. `active` is computed by the server against the current
  // pairing, so a collection stamped for a previous engagement is absent here
  // for the same reason the pull route would refuse it.
  //
  // Failure is recorded rather than thrown, and the distinction it preserves is
  // the whole point: an empty list because nothing is shared and an empty list
  // because the request failed read identically to the picker, which then told
  // a writer with several shared collections that they had none — and sent them
  // to type a name that already exists and collides.
  async function loadDestinations() {
    setDestError(null);
    try {
      const [sync, all] = await Promise.all([api.proSync(), api.getCollections()]);
      const shared = new Set(sync.stamps.filter((s) => s.active).map((s) => s.collection_id));
      setDestinations(all.filter((c) => shared.has(c.id)));
    } catch (err) {
      setDestError(errorMessage(err));
    }
  }

  // Copy a paper the organization holds into this library.
  //
  // The row is refreshed by re-asking about that one line rather than by
  // patching it from the pull response: a held row carries a file id and a
  // collection the reader can click through to, and assembling that here from
  // what the pull happened to return is how the two drift apart. One extra
  // request, on an action that just moved a whole PDF.
  //
  // A full check, network and all. This used to pass allowNetwork: false to
  // skip the free-copy lookup on a row about to come back held — but that flag
  // suppresses the org check too, so any pull that did *not* leave the paper
  // held locally refreshed into "Not in your library" with no org line at all.
  // A pull can succeed and still not match: the collection may already hold
  // these exact bytes under someone's manual match, which storePulledFile
  // deliberately refuses to overwrite. Losing the org line there turns a
  // conflict the writer could act on into the false negative this whole feature
  // exists to prevent.
  async function pull(index: number, pmid: string, collectionIds: number[]) {
    const line = response?.results[index]?.parsed.input;
    if (!line) return;
    setPulling(index);
    setError(null);
    try {
      const result = await api.proPull(pmid, collectionIds);
      setChoosing(null);
      // The one thing the re-check below cannot re-derive.
      //
      // A pull can succeed and still leave the row not-held: a chosen
      // collection may already hold these exact bytes under a match someone
      // made by hand, which is deliberately never overwritten. The row then
      // refreshes to "in your organization" with a Copy button, and clicking it
      // again does the same thing forever. Only the pull itself knows why, so
      // its answer is the one place that can say so.
      if (result.warning) setError(result.warning);
      // Before the re-check, not after: the copy is already filed, and the
      // collection the reader is looking at behind this modal is stale from
      // this moment. The re-check below only refreshes this row.
      onChanged();
      const fresh = await api.checkHave([line]);
      const updated = fresh.results[0];
      if (updated) {
        setResponse((r) =>
          r ? { ...r, results: r.results.map((a, i) => (i === index ? updated : a)) } : r
        );
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPulling(null);
    }
  }

  // Deliberately not cleared on close: reopening to re-read an answer you
  // already got is the common second visit, and a modal that forgets it makes
  // you paste the list again.
  function reset() {
    setText("");
    setResponse(null);
    setError(null);
    // The index refers to a row that no longer exists.
    setChoosing(null);
  }

  return (
    <ModalShell open={open} onClose={onClose} title={HAVE_CHECK_TITLE} wide>
      <form className="have-form" onSubmit={check}>
        <label htmlFor="have-input" className="hint">
          Paste PMIDs, DOIs, or PubMed links — one per line. Up to {MAX_HAVE_REFS} at a time.
        </label>
        <textarea
          id="have-input"
          className="have-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={5}
          autoFocus
          spellCheck={false}
        />
        <div className="modal-actions">
          {response && (
            <button type="button" onClick={reset}>
              Clear
            </button>
          )}
          <button type="submit" className="primary" disabled={refs.length === 0 || checking}>
            {checking && <span className="btn-spinner" aria-hidden="true" />}
            {checking
              ? "Checking…"
              : refs.length > 1
                ? `Check ${Math.min(refs.length, MAX_HAVE_REFS)} references`
                : "Check"}
          </button>
        </div>
      </form>

      {error && <Banner kind="error" message={error} onDismiss={() => setError(null)} />}
      {openError && <Banner kind="error" message={openError} onDismiss={clearOpenError} />}

      {response && (
        <div className="have-results">
          <Summary response={response} />
          <ul className="have-list">
            {response.results.map((answer, i) => (
              // Index-keyed on purpose: the same reference pasted twice is two
              // rows, and both must stay put.
              <AnswerRow
                key={i}
                answer={answer}
                onOpen={openPaper}
                // Copying writes to this library, so it follows the same rule as
                // every other mutation. A read-only viewer still sees that the
                // organization holds it — which is the answer they were told to
                // go and get — and is pointed at the person who can act on it.
                canPull={access.isAdmin}
                // The button opens the destination picker rather than copying:
                // where a paper is filed is the writer's decision, and it is
                // the only decision that keeps one organisation's material off
                // another's shelf.
                choosing={choosing === i}
                onChoose={() => setChoosing(i)}
                onCancel={() => setChoosing(null)}
                onPull={(collectionIds) => pull(i, answer.org!.pmid, collectionIds)}
                destinations={destinations}
                destError={destError}
                onReloadDestinations={() => void loadDestinations()}
                onCreated={(c) => {
                  setDestinations((d) => [...d, c]);
                  // The collection exists whether or not a copy ever lands in
                  // it, so the shell is told here rather than waiting for the
                  // Copy that may never be clicked.
                  onChanged();
                }}
                pulling={pulling === i}
                // "One at a time" was the stated design but nothing enforced
                // it: only the pulling row's own button was disabled, so a
                // second row could be started mid-transfer — and the first
                // pull's finally would then clear the second's spinner while
                // its bytes were still moving, with two refreshes racing to
                // set the same response.
                busy={pulling !== null}
              />
            ))}
          </ul>
          {response.truncated > 0 && (
            <p className="hint">
              {response.truncated} more line{response.truncated === 1 ? "" : "s"} weren’t
              checked — the limit is {MAX_HAVE_REFS} per paste.
            </p>
          )}
        </div>
      )}
    </ModalShell>
  );
}

// The headline the reader acts on. Ordered by what changes a decision: what you
// already have, then what you can get free, then what the app couldn't read.
function Summary({ response }: { response: HaveResponse }) {
  const { results } = response;
  const held = results.filter((r) => r.held).length;
  const org = results.filter((r) => !r.held && r.org).length;
  const free = results.filter((r) => !r.held && !r.org && r.free).length;
  const unreadable = results.filter((r) => r.parsed.kind === "unknown").length;
  return (
    <p className="have-summary">
      <strong>
        {held} of {results.length}
      </strong>{" "}
      already in your library.
      {org > 0 && ` ${org} more ${org === 1 ? "is" : "are"} held by your organization.`}
      {free > 0 && ` ${free} unowned ${free === 1 ? "paper has" : "papers have"} a free copy.`}
      {unreadable > 0 &&
        ` ${unreadable} line${unreadable === 1 ? "" : "s"} couldn’t be read.`}
    </p>
  );
}

function AnswerRow({
  answer,
  onOpen,
  canPull,
  choosing,
  onChoose,
  onCancel,
  onPull,
  destinations,
  destError,
  onReloadDestinations,
  onCreated,
  pulling,
  busy,
}: {
  answer: HaveAnswer;
  onOpen: (p: HaveMatch) => void;
  /** False for a viewer who can't mutate this library. */
  canPull: boolean;
  /** This row's destination picker is open. */
  choosing: boolean;
  onChoose: () => void;
  onCancel: () => void;
  onPull: (collectionIds: number[]) => void;
  /** Collections shared with the organisation — the only legal destinations. */
  destinations: Collection[];
  /** Why `destinations` is empty, when the reason is a failed load rather than none. */
  destError: string | null;
  onReloadDestinations: () => void;
  onCreated: (c: Collection) => void;
  /** This row's own transfer is in flight — drives the spinner and the label. */
  pulling: boolean;
  /** Some row's transfer is in flight. Disables every Copy button, not just this one. */
  busy: boolean;
}) {
  const { parsed, match, held, free, freeChecked, org } = answer;
  const kind = held
    ? "held"
    : parsed.kind === "unknown"
      ? "unreadable"
      : org
        ? "org-held"
        : "not-held";

  return (
    <li className={`have-row ${kind}`}>
      <div className="have-verdict">
        <Verdict kind={kind} />
        {match && <EvidenceBadge match={match} />}
      </div>

      {match && <PaperLine match={match} onOpen={onOpen} />}

      {/* Not for an org hit. A paper the organization holds but this library has
          never seen has no match row — the org line below *is* the answer, and
          "Nothing found for PMID 30000001 (identifier lookup skipped)" printed
          directly above "Held by Acme Medical" reads as a contradiction on the
          one row where the copy is most worth offering. */}
      {!match && !org && parsed.kind !== "unknown" && (
        <p className="have-nothing">
          Nothing found for {describe(parsed)}
          {freeChecked ? "" : " (identifier lookup skipped)"}.
        </p>
      )}

      {parsed.kind === "unknown" && <p className="have-nothing">{parsed.reason}</p>}

      {/* The org line sits above the free-copy one because it changes the
          decision more: a copy the agency already bought costs nothing and
          needs no licence argument. The server suppresses the free-copy lookup
          for these rows for the same reason. */}
      {!held && org && (
        <p className="have-org">
          <span>Held by {org.node}.</span>{" "}
          {/* Keyed off org.pmid, not match.pmid: the org can hold a paper this
              library has never seen, which is exactly the case with no match
              row — and the one where the copy is most worth offering. */}
          {canPull ? (
            <button
              type="button"
              className="have-pull"
              onClick={onChoose}
              disabled={busy || choosing}
            >
              {pulling && <span className="btn-spinner" aria-hidden="true" />}
              {pulling ? "Copying…" : "Copy to my library"}
            </button>
          ) : (
            <span>Ask your project manager for a copy.</span>
          )}
        </p>
      )}

      {/* Outside the org line rather than inside it: that line is a <p>, and a
          picker nested in one is invalid markup the browser silently reflows. */}
      {!held && org && choosing && (
        <DestinationPicker
          destinations={destinations}
          destError={destError}
          onReload={onReloadDestinations}
          onCreated={onCreated}
          onCancel={onCancel}
          onConfirm={onPull}
          busy={busy}
        />
      )}

      {/* Only ever offered for a paper the library doesn't hold: pointing at a
          free copy of something already on disk would invite a second copy. */}
      {!held && !org && free && (
        <a className="have-free" href={free.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={13} className="inline-icon" aria-hidden />
          Free copy
          {free.source ? ` on ${free.source}` : ""}
          {free.license ? ` (${free.license})` : ""}
        </a>
      )}
      {!held && !org && !free && freeChecked && parsed.kind !== "unknown" && (
        <span className="have-free none">No free copy found</span>
      )}

      {/* The line as pasted, so a long answer list can be read beside the
          original reference list without counting rows. */}
      <code className="have-input-echo">{parsed.input}</code>
    </li>
  );
}

// Where a copy goes, asked at the moment of copying.
//
// The list is only ever collections shared with the organisation being pulled
// from, which is the same set the route validates against — so nothing offered
// here can be refused there. That symmetry is the point of the whole control:
// the destination used to be derived from the organisation's *display name*,
// and two organisations sharing a name shared a shelf.
//
// Creating one inline shares it immediately rather than leaving that to a
// second step. A collection made to hold this organisation's material is that
// organisation's by construction — the same reasoning the New Collection
// dialog's pre-ticked box rests on — and an unshared one is a destination the
// route would refuse, so offering it unshared would put an untakeable choice
// on screen.
function DestinationPicker({
  destinations,
  destError,
  onReload,
  onCreated,
  onCancel,
  onConfirm,
  busy,
}: {
  destinations: Collection[];
  destError: string | null;
  onReload: () => void;
  onCreated: (c: Collection) => void;
  onCancel: () => void;
  onConfirm: (collectionIds: number[]) => void;
  busy: boolean;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function create() {
    const name = newName.trim();
    // `creating` as well as the name, matching the button's own predicate.
    // Enter has no form to submit here, so the handler is the only guard on
    // that path — and without this, two quick presses read one render's
    // `newName`, fire two creates, and the second comes back "name taken"
    // against a collection the first had just made, shared and ticked.
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);

    let made: Collection;
    try {
      made = await api.createCollection(name);
    } catch (err) {
      setCreateError(errorMessage(err));
      setCreating(false);
      return;
    }

    // Sharing is a second request, and its failure must not lose the
    // collection — it exists, and its name is now taken under a unique index,
    // so an unwound-looking failure sends the writer to retype a name that can
    // only ever answer "name taken" from here on. Same reasoning as
    // createCollection in App.tsx, which wraps this identical call for this
    // identical reason.
    //
    // Not offered as a destination, though: unshared is exactly what the pull
    // route refuses, so listing it would be the untakeable choice this picker
    // exists to avoid. Named in the message instead, so the writer knows what
    // exists and what to do about it.
    try {
      await api.proShareCollection(made.id);
    } catch (err) {
      setCreateError(
        `Created “${made.name}”, but sharing it with your organization failed: ${errorMessage(err)} ` +
          `Copies can only go to a shared collection — share it in Settings, then check again.`
      );
      setNewName("");
      setCreating(false);
      return;
    }

    onCreated(made);
    // Ticked on arrival: naming a collection here is already the choice to
    // copy into it, and leaving it unticked means a Copy button that stays
    // disabled directly under the thing you just made.
    setPicked((p) => [...p, made.id]);
    setNewName("");
    setCreating(false);
  }

  return (
    <div className="have-dest">
      {/* Three states, not two. "Nothing is shared" is a claim about the
          library, and making it off the back of a request that never answered
          told writers with several shared collections that they had none —
          then sent them to type a name that already exists and collides. */}
      {destError ? (
        <p className="have-dest-failed">
          Couldn’t load your shared collections: {destError}{" "}
          <button type="button" onClick={onReload}>
            Try again
          </button>
        </p>
      ) : destinations.length === 0 ? (
        <p className="hint">
          No collections are shared with your organization yet — name one below.
        </p>
      ) : (
        <>
          <p className="hint">Copy into:</p>
          <ul className="have-dest-list">
            {destinations.map((c) => (
              <li key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.includes(c.id)}
                    onChange={() =>
                      setPicked((p) =>
                        p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]
                      )
                    }
                  />
                  {c.name}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="have-dest-new">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New collection"
          spellCheck={false}
          // This sits outside the check form above it, so Enter would otherwise
          // do nothing at all here. create() carries the same `creating` guard
          // the button's `disabled` does — key repeat is the one input that
          // reaches it twice before the first request returns.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
          }}
        />
        <button type="button" onClick={() => void create()} disabled={!newName.trim() || creating}>
          {creating ? "Creating…" : "Create"}
        </button>
      </div>
      {createError && <Banner kind="error" message={createError} onDismiss={() => setCreateError(null)} />}

      <div className="have-dest-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => onConfirm(picked)}
          disabled={picked.length === 0 || busy}
        >
          Copy
        </button>
      </div>
    </div>
  );
}

function Verdict({ kind }: { kind: string }) {
  if (kind === "held") {
    return (
      <span className="have-pill held">
        <Check size={13} className="inline-icon" aria-hidden /> In your library
      </span>
    );
  }
  if (kind === "unreadable") {
    return (
      <span className="have-pill unreadable">
        <TriangleAlert size={13} className="inline-icon" aria-hidden /> Couldn’t read this
      </span>
    );
  }
  // Distinct from both: not a purchase, but not something you can open either.
  // Saying "not in your library" here would send a writer to buy a paper the
  // agency already owns, which is the whole failure this feature exists to stop.
  if (kind === "org-held") {
    return (
      <span className="have-pill org-held">
        <Users size={13} className="inline-icon" aria-hidden /> In your organization
      </span>
    );
  }
  return (
    <span className="have-pill not-held">
      <Minus size={13} className="inline-icon" aria-hidden /> Not in your library
    </span>
  );
}

// Whether the paper reports original data, from PubMed's publication types.
//
// A label, never a filter: the rule clients actually apply is that a *claim*
// must trace back to original data, and reviews are both where writers start
// and perfectly citable for statements that don't rest on numbers. So the
// useful thing to say is "if you're taking a number out of this one, go find
// its source" — not "don't use this."
//
// `untyped` draws nothing. NLM leaves about half of all records with no design
// tag, and that bucket is usually — not certainly — primary research; a badge
// on every second row that means "we don't know" is noise, and a badge saying
// "Primary" would be wrong often enough to matter.
function EvidenceBadge({ match }: { match: HaveMatch }) {
  if (match.evidence === "secondary") {
    return (
      <span
        className="eve-badge secondary"
        title={`${match.pub_types.join(", ")} — cite it for statements that don't rest on data, but trace any number back to the primary source`}
      >
        {match.pub_types[0] ?? "Not primary"}
      </span>
    );
  }
  if (match.evidence === "primary") {
    return (
      <span className="eve-badge primary" title={match.pub_types.join(", ")}>
        Primary
      </span>
    );
  }
  return null;
}

// One identified paper: title (opening the stored PDF when there is one, PubMed
// otherwise), then who and where.
function PaperLine({
  match,
  onOpen,
}: {
  match: HaveMatch;
  onOpen: (p: HaveMatch) => void;
}) {
  const meta = [
    formatAuthors(match.authors, 3),
    match.journal_name && titleCaseJournal(match.journal_name),
    match.pub_date_display,
  ].filter((s) => s && s !== "—");
  const label = match.title || match.doi || (match.pmid && `PMID ${match.pmid}`) || "Untitled";
  // A paper OpenAlex knew nothing about beyond its identifier can have neither a
  // stored file nor a landing page. Drawing that as a link would open a blank
  // tab, so it stays plain text — there is genuinely nowhere to go.
  const openable = match.file_id != null || match.url !== "";
  return (
    <div className="have-paper">
      {openable ? (
        <button type="button" className="have-title" onClick={() => onOpen(match)}>
          {label}
        </button>
      ) : (
        <span className="have-title plain">{label}</span>
      )}
      {meta.length > 0 && <div className="have-meta">{meta.join(" · ")}</div>}
      {match.held && match.collection_name && (
        <div className="have-where">
          <FileText size={13} className="inline-icon" aria-hidden />
          {match.file_exists ? match.file_name : `${match.file_name} (file missing)`} — in{" "}
          {match.collection_name}
        </div>
      )}
    </div>
  );
}

// How the app read a line, in the reader's terms. Shown wherever an answer has
// to name what it searched for, so a wrong parse is visible rather than showing
// up as a mysteriously empty result.
function describe(parsed: ParsedRefView): string {
  if (parsed.kind === "pmid") return `PMID ${parsed.pmid}`;
  if (parsed.kind === "doi") return `DOI ${parsed.doi}`;
  return parsed.input;
}
