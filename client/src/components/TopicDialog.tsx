import { FormEvent, useEffect, useLayoutEffect, useState } from "react";
import { Info, X } from "lucide-react";
import { api } from "../api";
import { errorMessage, plural } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import { Banner } from "./Banner";
import { ModalShell } from "./Dialogs";
import { Typeahead } from "./Typeahead";
import {
  MAX_TOPIC_HEADINGS,
  MAX_TOPIC_NAME_CHARS,
  PUBMED_MAX_RESULTS,
} from "../../../shared/limits";
import { defaultTopicName } from "../../../shared/topic";
import type { MeshDescriptorRef, MeshSearchResult, Topic, TopicSuggestResponse } from "../types";

// One dialog for a topic, creating it or editing it.
//
// A topic is the MeSH headings a paper must carry all of. Creating one is
// picking them; the dialog counts what they match across PubMed as they are
// picked, because that number is what says whether a combination is a reading
// list or more than PubMed will hand over. Editing one changes its name and
// nothing else — the headings are fixed once a topic exists (see
// Topic.headings), so they are shown and not offered.

// What the library's own filing suggests watching, when it has anything to say.
const NO_SUGGESTIONS: TopicSuggestResponse = { results: [], heldPapers: 0, unchecked: 0 };

// One option in the heading search: a MeSH hit while typing, or, with the box
// empty, a heading the Library's filing suggests, which carries its counts.
type HeadingOption = MeshSearchResult & { papers?: number; majorPapers?: number };

const ALL_REQUIRED = `A paper must carry all of these headings. Up to ${MAX_TOPIC_HEADINGS}.`;
const FIXED = "Headings can't be changed. To search different ones, create a new topic.";

export function TopicDialog({
  open,
  topic,
  onClose,
  onSaved,
}: {
  open: boolean;
  // The topic being edited, or null to create one.
  topic: Topic | null;
  onClose: () => void;
  // The topic as the server stored it. Called before the dialog closes.
  onSaved: (topic: Topic) => void;
}) {
  const [headings, setHeadings] = useState<MeshDescriptorRef[]>([]);
  const [query, setQuery] = useState("");
  // The name box shows the headings' own name until someone types in it; from
  // then on it is theirs, and picking another heading no longer rewrites it.
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [suggested, setSuggested] = useState<TopicSuggestResponse>(NO_SUGGESTIONS);
  // The count, with the set of headings it was taken for: a reading for another
  // set is no answer for this one. `count` is null when PubMed couldn't say.
  const [preview, setPreview] = useState<{ key: string; count: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editing = topic != null;

  // Each opening starts fresh, before paint, as JournalManager's does.
  useLayoutEffect(() => {
    if (!open) return;
    setHeadings([]);
    setQuery("");
    setName(topic?.name ?? "");
    setNameTouched(topic != null);
    setPreview(null);
    setSaving(false);
    setError(null);
    // Keyed on which topic, not on the object: the shell reloads its topics
    // when a check for new papers lands, which hands this a new object for the
    // same topic and would otherwise wipe a name half typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, topic?.id]);

  // Topics the Library's own filing points at, so the first heading doesn't
  // have to be guessed cold. Advisory: the dialog is whole without them.
  useEffect(() => {
    if (!open || editing) return;
    let active = true;
    api
      .suggestTopics()
      .then((s) => active && setSuggested(s))
      .catch(() => active && setSuggested(NO_SUGGESTIONS));
    return () => {
      active = false;
    };
  }, [open, editing]);

  const key = headings.map((h) => h.ui).join(",");
  const countedKey = useDebounced(key, 300);
  useEffect(() => {
    if (!open || editing || countedKey === "") return;
    let active = true;
    api
      .previewTopic(countedKey.split(","))
      .then((r) => active && setPreview({ key: countedKey, count: r.count }))
      // A count that can't be had is not a reason to refuse the topic.
      .catch(() => active && setPreview({ key: countedKey, count: null }));
    return () => {
      active = false;
    };
  }, [countedKey, open, editing]);

  const picked = new Set(headings.map((h) => h.ui));
  const full = headings.length >= MAX_TOPIC_HEADINGS;

  function addHeading(h: MeshDescriptorRef) {
    setQuery("");
    if (picked.has(h.ui) || full) return;
    setHeadings([...headings, { ui: h.ui, name: h.name }]);
  }

  const libraryPicks: HeadingOption[] = suggested.results
    .filter((s) => !picked.has(s.ui))
    .map((s) => ({ ...s, synonym: null }));
  const libraryNote =
    libraryPicks.length > 0
      ? `From your Library (${plural(suggested.heldPapers, "filed paper")})`
      : // The one case worth explaining rather than leaving blank: there are
        // held papers, but their headings haven't been fetched yet.
        suggested.unchecked > 0 && suggested.results.length === 0
        ? `Still reading MeSH headings for ${plural(suggested.unchecked, "paper")} in your ` +
          "Library — suggestions will appear here once that finishes."
        : undefined;

  const autoName = defaultTopicName(headings);
  const shownName = nameTouched ? name : autoName;
  const typedName = shownName.trim();

  const canSave = topic ? typedName !== "" && typedName !== topic.name : headings.length > 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      const saved = topic
        ? await api.renameTopic(topic.id, typedName)
        : // A name nobody typed is left for the server to give, so the two
          // can't drift; a blanked box asks for the same thing.
          await api.createTopic(
            headings.map((h) => h.ui),
            nameTouched && typedName !== "" ? typedName : undefined
          );
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // One line, always present, so the dialog is the same height whatever it says.
  const counted = preview && preview.key === key ? preview : null;
  const overCap = counted?.count != null && counted.count > PUBMED_MAX_RESULTS;
  const countLine =
    headings.length === 0 ? (
      "Pick a heading to see how many papers match."
    ) : !counted ? (
      "Counting matches…"
    ) : counted.count == null ? (
      "Couldn't count matches just now."
    ) : (
      <>
        <strong>{counted.count.toLocaleString()}</strong> {counted.count === 1 ? "paper" : "papers"}{" "}
        in PubMed {counted.count === 1 ? "matches" : "match"}
        {overCap &&
          `, more than the ${PUBMED_MAX_RESULTS.toLocaleString()} one search returns. Add a heading to narrow it.`}
      </>
    );

  return (
    <ModalShell
      open={open}
      onClose={() => !saving && onClose()}
      title={topic ? "Edit topic" : "New topic"}
    >
      <form className="topic-form" onSubmit={save}>
        <Banner kind="error" message={error} onDismiss={() => setError(null)} />

        <div className="topic-label first">
          <span id="topic-headings-label">MeSH headings</span>
          <span
            className="info-tip"
            role="img"
            title={topic ? FIXED : ALL_REQUIRED}
            aria-label={topic ? FIXED : ALL_REQUIRED}
          >
            <Info size={14} aria-hidden />
          </span>
        </div>
        <div className={`topic-headings${topic ? " fixed" : ""}`}>
          {(topic ? topic.headings : headings).length > 0 && (
            <ul className="topic-chips" aria-labelledby="topic-headings-label">
              {(topic ? topic.headings : headings).map((h) => (
                <li key={h.ui} className="topic-chip">
                  <span>{h.name}</span>
                  {!topic && (
                    <button
                      type="button"
                      aria-label={`Remove ${h.name}`}
                      onClick={() => setHeadings(headings.filter((x) => x.ui !== h.ui))}
                    >
                      <X size={12} aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/* A topic from before headings were recorded has none to show, and
              still searches something: its term says what. */}
          {topic && topic.headings.length === 0 && <code className="term">{topic.term}</code>}
          {!topic && (
            <Typeahead<HeadingOption>
              value={query}
              onChange={setQuery}
              search={(q) =>
                api.searchMesh(q).then((r) => r.results.filter((m) => !picked.has(m.ui)))
              }
              onSelect={addHeading}
              getKey={(m) => m.ui}
              idleItems={libraryPicks}
              idleLabel={libraryNote}
              disabled={full}
              placeholder={
                full
                  ? `${MAX_TOPIC_HEADINGS} of ${MAX_TOPIC_HEADINGS} headings`
                  : headings.length > 0
                    ? "Add a heading…"
                    : libraryPicks.length > 0
                      ? "Search MeSH, or click for suggestions from your Library…"
                      : "Search MeSH (e.g. type 2 diabetes)…"
              }
              id="topic-heading-search"
              renderItem={(m) => (
                <>
                  <span className="ta-title">{m.name}</span>
                  {m.synonym && (
                    <span className="ta-synonym">
                      <span className="sr-only">, matched synonym </span>
                      {m.synonym}
                    </span>
                  )}
                  {m.papers != null && (
                    <span
                      className="ta-count"
                      title={`${m.majorPapers} of ${m.papers} are mainly about this`}
                    >
                      <span className="sr-only">, filed papers: </span>
                      {m.papers}
                    </span>
                  )}
                </>
              )}
            />
          )}
        </div>
        {!topic && (
          <p className={`topic-count${overCap ? " warn" : ""}`} role="status">
            {countLine}
          </p>
        )}

        <label className="topic-label" htmlFor="topic-name">
          Name
        </label>
        <input
          id="topic-name"
          value={shownName}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
          placeholder={autoName || "Topic name"}
          maxLength={MAX_TOPIC_NAME_CHARS}
        />

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!canSave || saving}>
            {topic ? "Save" : "Create topic"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
