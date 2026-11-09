import { useEffect, useRef, useState, type FormEvent } from "react";
import { BookmarkCheck, Check, TriangleAlert } from "lucide-react";
import { api } from "../api";
import { describeRef, errorMessage, paperMeta, plural } from "../lib/format";
import { MAX_LINKS, MAX_LINKS_PER_REQUEST } from "../../../shared/limits";
import type { LinkAnswer, LinkOutcome, LinkedPaper } from "../types";
import { Banner } from "./Banner";
import { ModalShell } from "./Dialogs";

// The modal's title.
export const ADD_LINKS_TITLE = "Add links";

// "Add links" — a bookmark folder's way in for a paper found outside Interests.
//
// The same paste box as Check holdings, reading lines by the same rules on the
// server: a DOI (bare, a doi.org link, or inside a publisher's URL) or a PubMed
// link, alone or inside a full reference. Each named paper is looked up on
// PubMed and saved into the folder; one that PubMed has no record of can't be.
//
// Answers keep the input's order, one per line, so the list can be read down
// beside the original — and a link that didn't work is a row that says so,
// rather than the folder silently holding fewer papers than were pasted.

const PLACEHOLDER = `https://pubmed.ncbi.nlm.nih.gov/33301246/
https://doi.org/10.1056/NEJMoa2035389`;

export function AddLinks({
  open,
  onClose,
  folderId,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  folderId: number;
  /** Papers were saved into the folder — its list and counts behind this modal are stale. */
  onAdded: () => void;
}) {
  const [text, setText] = useState("");
  const [answers, setAnswers] = useState<LinkAnswer[] | null>(null);
  // Lines done of lines sent, while a paste is being added; null otherwise.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // Lines past MAX_LINKS, which were never sent.
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Whether the dialog is still on screen. The folder view is keyed by folder,
  // so leaving the folder mid-paste unmounts this: the batch in flight still
  // lands, since the server saves it whether or not anyone waits for the
  // answer, but the ones after it are never sent — rather than going on saving
  // into a folder no longer on screen, with nowhere left to say what happened.
  // Set on mount as well as cleared on unmount, for StrictMode's
  // mount-unmount-mount.
  const mounted = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const lines = text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Batches go one after another, and each one's answers are shown as it
  // lands: a DOI is a throttled PubMed search, so a long paste takes a while,
  // and the rows arriving are the progress. A batch that fails stops the run
  // but keeps what the earlier ones did — those papers are saved, and their
  // rows are the only record of which lines got in.
  //
  // The last paste's rows come down as this one starts. Left up under
  // "Adding…", they read as this paste's answers — a reader closing the
  // dialog mid-run took the old "2 of 2 added" for the new list. The dialog
  // hangs from its top edge (the rule beside .have-results in styles.css), so
  // taking them down moves only its bottom, not the box and the Add button.
  async function add(e: FormEvent) {
    e.preventDefault();
    if (lines.length === 0 || progress) return;
    const submitted = text;
    const capped = lines.slice(0, MAX_LINKS);
    const done: LinkAnswer[] = [];
    // Lines answered without getting into the folder, in paste order.
    const missed: string[] = [];
    // The first line of the paste that no batch has answered.
    let next = 0;
    let over = lines.length - capped.length;
    let added = false;
    setError(null);
    setAnswers(null);
    setSkipped(over);
    try {
      for (let i = 0; i < capped.length; i += MAX_LINKS_PER_REQUEST) {
        setProgress({ done: i, total: capped.length });
        const batch = capped.slice(i, i + MAX_LINKS_PER_REQUEST);
        const res = await api.addBookmarkLinks(folderId, batch);
        if (res.results.some((a) => a.outcome === "added")) added = true;
        if (!mounted.current) return;
        done.push(...res.results);
        over += res.truncated;
        // One answer per line, in order; a line past the answers was cut.
        missed.push(...batch.filter((_, j) => !landed(res.results[j])));
        next = i + batch.length;
        setAnswers([...done]);
        setSkipped(over);
      }
    } catch (err) {
      if (!mounted.current) return;
      const left = capped.length - done.length;
      setError(
        done.length > 0
          ? `${errorMessage(err)} The ${plural(left, "line")} after the first ${done.length} ${wasnt(left)} added.`
          : errorMessage(err)
      );
    } finally {
      // Once per paste: after the last batch, the one that failed, or the one
      // in flight when the dialog went away. Called per batch, the reloads it
      // starts overlapped, and an older one landing last showed papers just
      // saved as unsaved.
      if (added) onAdded();
      if (mounted.current) {
        setProgress(null);
        // The box keeps only what is left to do: the lines that came back
        // without getting in, to be corrected there, then every line not yet
        // sent, past the limit or after a batch that failed, which has no row
        // to be recovered from. Kept whole, the next Add sent the first 300
        // again, all saved already, and never reached the lines after them.
        // A paste that got nothing in is left as typed, and so is a box
        // edited while the batches went.
        const left = [...missed, ...lines.slice(next)];
        if (left.length < lines.length) setText((t) => (t === submitted ? left.join("\n") : t));
        // Back to the box for whatever is typed next, a fresh paste or a
        // correction, if the run left focus nowhere: Add had it and was
        // disabled under it, which drops it to the page, or to the dialog
        // itself once Radix sees a node inside it removed. Where the reader
        // moved it while the batches went, it stays.
        const at = document.activeElement;
        const dialog = inputRef.current?.closest("[role=dialog]");
        if (!at || at === document.body || at === addRef.current || at === dialog) {
          inputRef.current?.focus();
        }
      }
    }
  }

  // Deliberately not cleared on close, like Check holdings: reopening to
  // re-read the answers is the common second visit.
  function reset() {
    setText("");
    setAnswers(null);
    setSkipped(0);
    setError(null);
  }

  return (
    <ModalShell open={open} onClose={onClose} title={ADD_LINKS_TITLE} wide initialFocus={inputRef}>
      <form className="have-form" onSubmit={add}>
        <label htmlFor="add-links-input" className="hint">
          Paste DOIs or PubMed links — one per line, up to {MAX_LINKS} at a time. Each paper is
          looked up on PubMed and saved into this folder.
        </label>
        <textarea
          ref={inputRef}
          id="add-links-input"
          className="have-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={5}
          spellCheck={false}
        />
        <div className="modal-actions">
          {answers && !progress && (
            <button type="button" onClick={reset}>
              Clear
            </button>
          )}
          <button
            ref={addRef}
            type="submit"
            className="primary"
            disabled={lines.length === 0 || progress != null}
          >
            {progress && <span className="btn-spinner" aria-hidden="true" />}
            {progress
              ? progress.total > MAX_LINKS_PER_REQUEST
                ? `Adding… ${progress.done} of ${progress.total}`
                : "Adding…"
              : lines.length > 1
                ? `Add ${Math.min(lines.length, MAX_LINKS)} links`
                : "Add"}
          </button>
        </div>
      </form>

      <Banner kind="error" message={error} onDismiss={() => setError(null)} />

      {answers && (
        <div className="have-results">
          <Summary answers={answers} />
          <ul className="have-list">
            {answers.map((answer, i) => (
              // Index-keyed on purpose: the same link pasted twice is two rows.
              <AnswerRow key={i} answer={answer} />
            ))}
          </ul>
          {skipped > 0 && (
            <p className="hint">
              {plural(skipped, "more line")} {wasnt(skipped)} added — the limit is {MAX_LINKS} per paste.
            </p>
          )}
        </div>
      )}
    </ModalShell>
  );
}

// In the folder now, whether this paste put it there or it already was.
function landed(answer: LinkAnswer | undefined): boolean {
  return answer?.outcome === "added" || answer?.outcome === "already-saved";
}

// "wasn’t" or "weren’t", to follow a count.
function wasnt(n: number): string {
  return n === 1 ? "wasn’t" : "weren’t";
}

// The headline: what landed, then each reason a line didn't.
function Summary({ answers }: { answers: LinkAnswer[] }) {
  const count = (o: LinkOutcome) => answers.filter((a) => a.outcome === o).length;
  const already = count("already-saved");
  const missing = count("not-in-pubmed");
  const ambiguous = count("ambiguous-doi");
  const unreadable = count("unreadable");
  return (
    <p className="have-summary">
      <strong>
        {count("added")} of {answers.length}
      </strong>{" "}
      added to this folder.
      {already > 0 && ` ${already} ${already === 1 ? "was" : "were"} already in it.`}
      {missing > 0 && ` ${missing} ${missing === 1 ? "isn’t" : "aren’t"} in PubMed.`}
      {ambiguous > 0 &&
        ` ${plural(ambiguous, "DOI")} ${ambiguous === 1 ? "matches" : "match"} more than one PubMed record.`}
      {unreadable > 0 && ` ${plural(unreadable, "line")} couldn’t be read.`}
    </p>
  );
}

// The row colours are Check holdings' own: green for a paper that landed, the
// warning edge for a line that needs the reader's attention, and the plain row
// for one that needed nothing.
const ROW_CLASS: Record<LinkOutcome, string> = {
  added: "held",
  "already-saved": "",
  "not-in-pubmed": "unreadable",
  "ambiguous-doi": "unreadable",
  unreadable: "unreadable",
};

function AnswerRow({ answer }: { answer: LinkAnswer }) {
  const { parsed, outcome, paper } = answer;
  return (
    <li className={`have-row ${ROW_CLASS[outcome]}`}>
      <div className="have-verdict">
        <Outcome outcome={outcome} />
      </div>
      {paper && <PaperLine paper={paper} />}
      {outcome === "not-in-pubmed" && (
        <p className="have-nothing">PubMed has no record for {describeRef(parsed)}.</p>
      )}
      {outcome === "ambiguous-doi" && (
        <p className="have-nothing">
          PubMed has more than one record for {describeRef(parsed)} — paste the paper’s PubMed link
          instead.
        </p>
      )}
      {outcome === "unreadable" && <p className="have-nothing">{parsed.reason}</p>}
      <code className="have-input-echo">{parsed.input}</code>
    </li>
  );
}

function Outcome({ outcome }: { outcome: LinkOutcome }) {
  if (outcome === "added") {
    return (
      <span className="have-pill held">
        <Check size={13} className="inline-icon" aria-hidden /> Added
      </span>
    );
  }
  if (outcome === "already-saved") {
    return (
      <span className="have-pill">
        <BookmarkCheck size={13} className="inline-icon" aria-hidden /> Already in this folder
      </span>
    );
  }
  return (
    <span className="have-pill unreadable">
      <TriangleAlert size={13} className="inline-icon" aria-hidden />{" "}
      {outcome === "not-in-pubmed"
        ? "Not in PubMed"
        : outcome === "ambiguous-doi"
          ? "Several in PubMed"
          : "Couldn’t read this"}
    </span>
  );
}

// Title (opening the paper on PubMed), then who and where — Check holdings'
// paper line, for a paper that never has a stored file to open instead.
function PaperLine({ paper }: { paper: LinkedPaper }) {
  const meta = paperMeta(paper);
  return (
    <div className="have-paper">
      <button
        type="button"
        className="have-title"
        onClick={() => window.open(paper.url, "_blank", "noopener")}
      >
        {paper.title || `PMID ${paper.pmid}`}
      </button>
      {meta && <div className="have-meta">{meta}</div>}
    </div>
  );
}
