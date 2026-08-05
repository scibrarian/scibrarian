import { useState, type FormEvent } from "react";
import { Check, ExternalLink, FileText, HelpCircle, Minus, TriangleAlert } from "lucide-react";
import { api } from "../api";
import { errorMessage, formatAuthors, titleCaseJournal } from "../lib/format";
import { usePaperOpener, type PaperAccess } from "../lib/openPaper";
import { MAX_HAVE_REFS } from "../../../shared/limits";
import type { HaveAnswer, HaveMatch, HaveResponse, ParsedRefView } from "../types";
import { Banner } from "./Banner";
import { ModalShell } from "./Dialogs";

// "Check references" — the check a writer is required to run before asking a
// project manager to approve buying an article.
//
// The point of the design is that it accepts *whatever is on the clipboard*. A
// writer working from a client-formatted reference doesn't have a PMID to hand;
// they have `[Smith 2019/p1699/col2/par1/lines 6-12]`. Making them extract an
// identifier first would put the app's convenience ahead of the step it's
// supposed to accelerate, and the step is already mandatory and already manual.
//
// Answers keep the input's order and there is always exactly one per line, so a
// pasted reference list can be read straight down beside the original.

const PLACEHOLDER = `10.1056/NEJMoa2035389
PMID: 33301246
[Smith 2019/p1699/col2/par1/lines 6-12]
Jones AB, Lee C. Effects of foo on bar. Lancet. 2022;399:1120-31.`;

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

  // Deliberately not cleared on close: reopening to re-read an answer you
  // already got is the common second visit, and a modal that forgets it makes
  // you paste the list again.
  function reset() {
    setText("");
    setResponse(null);
    setError(null);
  }

  return (
    <ModalShell open={open} onClose={onClose} title="Check references" wide>
      <form className="have-form" onSubmit={check}>
        <label htmlFor="have-input" className="hint">
          Paste PMIDs, DOIs, PubMed links, or citations — one per line. Up to{" "}
          {MAX_HAVE_REFS} at a time.
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
              <AnswerRow key={i} answer={answer} onOpen={openPaper} />
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
  const free = results.filter((r) => !r.held && r.free).length;
  const unreadable = results.filter((r) => r.parsed.kind === "unknown").length;
  return (
    <p className="have-summary">
      <strong>
        {held} of {results.length}
      </strong>{" "}
      already in your library.
      {free > 0 && ` ${free} unowned ${free === 1 ? "paper has" : "papers have"} a free copy.`}
      {unreadable > 0 &&
        ` ${unreadable} line${unreadable === 1 ? "" : "s"} couldn’t be read.`}
    </p>
  );
}

function AnswerRow({
  answer,
  onOpen,
}: {
  answer: HaveAnswer;
  onOpen: (p: HaveMatch) => void;
}) {
  const { parsed, match, candidates, held, free, freeChecked } = answer;
  const several = candidates.length > 0;
  const kind = held ? "held" : parsed.kind === "unknown" ? "unreadable" : "not-held";

  return (
    <li className={`have-row ${kind}`}>
      <div className="have-verdict">
        <Verdict kind={kind} several={several} />
        {match && <EvidenceBadge match={match} />}
      </div>

      {several && (
        <>
          <p className="have-ambiguous">
            {candidates.length} papers in your library match {describe(parsed)}. Which one?
          </p>
          <ul className="have-candidates">
            {candidates.map((c) => (
              <li key={c.pmid}>
                <PaperLine match={c} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </>
      )}

      {!several && match && <PaperLine match={match} onOpen={onOpen} />}

      {!several && !match && parsed.kind !== "unknown" && (
        <p className="have-nothing">
          Nothing found for {describe(parsed)}
          {freeChecked ? "" : " (identifier lookup skipped)"}.
        </p>
      )}

      {parsed.kind === "unknown" && <p className="have-nothing">{parsed.reason}</p>}

      {/* Only ever offered for a paper the library doesn't hold: pointing at a
          free copy of something already on disk would invite a second copy. */}
      {!held && free && (
        <a className="have-free" href={free.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={13} className="inline-icon" aria-hidden />
          Free copy
          {free.source ? ` on ${free.source}` : ""}
          {free.license ? ` (${free.license})` : ""}
        </a>
      )}
      {!held && !free && freeChecked && parsed.kind !== "unknown" && (
        <span className="have-free none">No free copy found</span>
      )}

      {/* The line as pasted, so a long answer list can be read beside the
          original reference list without counting rows. */}
      <code className="have-input-echo">{parsed.input}</code>
    </li>
  );
}

function Verdict({ kind, several }: { kind: string; several: boolean }) {
  if (several) {
    return (
      <span className="have-pill ambiguous">
        <HelpCircle size={13} className="inline-icon" aria-hidden /> Several matches
      </span>
    );
  }
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
  if (parsed.kind === "citation") return `${parsed.author}, ${parsed.year}`;
  return parsed.input;
}
