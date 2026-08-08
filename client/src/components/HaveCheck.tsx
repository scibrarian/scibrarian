import { useState, type FormEvent } from "react";
import { Check, ExternalLink, FileText, Minus, TriangleAlert, Users } from "lucide-react";
import { api } from "../api";
import { errorMessage, formatAuthors, titleCaseJournal } from "../lib/format";
import { usePaperOpener, type PaperAccess } from "../lib/openPaper";
import { MAX_HAVE_REFS } from "../../../shared/limits";
import type { HaveAnswer, HaveMatch, HaveResponse, ParsedRefView } from "../types";
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
}: {
  open: boolean;
  onClose: () => void;
  access: PaperAccess;
}) {
  const [text, setText] = useState("");
  const [response, setResponse] = useState<HaveResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which row is mid-copy, by index. One at a time: each pull moves a whole
  // PDF, and a list of simultaneous transfers is neither useful nor readable.
  const [pulling, setPulling] = useState<number | null>(null);
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
      setResponse(await api.checkHave(refs));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  // Copy a paper the organization holds into this library.
  //
  // The row is refreshed by re-asking about that one line rather than by
  // patching it from the pull response: a held row carries a file id and a
  // collection the reader can click through to, and assembling that here from
  // what the pull happened to return is how the two drift apart. One extra
  // request, on an action that just moved a whole PDF.
  async function pull(index: number, pmid: string) {
    const line = response?.results[index]?.parsed.input;
    if (!line) return;
    setPulling(index);
    setError(null);
    try {
      await api.proPull(pmid);
      const fresh = await api.checkHave([line], false);
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
                onPull={access.isAdmin ? (pmid) => pull(i, pmid) : null}
                pulling={pulling === i}
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
  onPull,
  pulling,
}: {
  answer: HaveAnswer;
  onOpen: (p: HaveMatch) => void;
  /** Null for a viewer who can't mutate this library. */
  onPull: ((pmid: string) => void) | null;
  pulling: boolean;
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

      {!match && parsed.kind !== "unknown" && (
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
          {onPull ? (
            <button
              type="button"
              className="have-pull"
              onClick={() => onPull(org.pmid)}
              disabled={pulling}
            >
              {pulling && <span className="btn-spinner" aria-hidden="true" />}
              {pulling ? "Copying…" : "Copy to my library"}
            </button>
          ) : (
            <span>Ask your project manager for a copy.</span>
          )}
        </p>
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
