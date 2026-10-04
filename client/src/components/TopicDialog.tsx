import { FormEvent, useEffect, useLayoutEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "../api";
import { errorMessage, plural } from "../lib/format";
import { useHeldWhile } from "../lib/hooks";
import { Banner } from "./Banner";
import { ConfirmDialog, ModalShell } from "./Dialogs";
import { InfoTip } from "./InfoTip";
import { JournalPanes, listedFromStored, type ListedJournal } from "./JournalPanes";
import { Typeahead } from "./Typeahead";
import {
  MAX_TOPIC_HEADINGS,
  MAX_TOPIC_NAME_CHARS,
  PUBMED_MAX_RESULTS,
} from "../../../shared/limits";
import { defaultTopicName } from "../../../shared/topic";
import type {
  MeshDescriptorRef,
  MeshSearchResult,
  Topic,
  TopicDetail,
  TopicScopeInput,
  TopicSuggestResponse,
} from "../types";

// One dialog for a topic, creating it or editing it.
//
// A topic is the MeSH headings a paper must carry all of, and where it looks
// for them: every journal in PubMed, or a list of its own. Creating one is
// picking both; the dialog counts what the headings match across PubMed as
// they are picked, because that number is what says whether a combination can
// search everything or needs a list. Editing one changes its name and its
// scope — the headings are fixed once a topic exists (see Topic.headings), so
// they are shown and not offered.
//
// Nothing is stored until the button at the bottom. A change of scope that
// would take papers out of the topic says how many first.

// What the library's own filing suggests watching, when it has anything to say.
const NO_SUGGESTIONS: TopicSuggestResponse = { results: [], heldPapers: 0, unchecked: 0 };

// One option in the heading search: a MeSH hit while typing, or, with the box
// empty, a heading the Library's filing suggests, which carries its counts.
type HeadingOption = MeshSearchResult & { papers?: number; majorPapers?: number };

const ALL_REQUIRED = `A paper must carry all of these headings. Up to ${MAX_TOPIC_HEADINGS}.`;
const FIXED = "Headings can't be changed. To search different ones, create a new topic.";

// What saving did that the reader should hear about, beyond the topic now
// being as they left it.
export interface TopicSaveOutcome {
  created: boolean;
  // Papers a change of scope took out of the topic's feed.
  removed: number;
  // Journals just listed that MEDLINE doesn't index, by name.
  unindexed: string[];
}

// That outcome as a sentence or two, or null when there is nothing to say.
// For the shell's notice, wherever the dialog was opened from: a warning
// inside a dialog that has just closed is one nobody reads.
export function describeTopicSave(topic: Topic, outcome: TopicSaveOutcome): string | null {
  const parts: string[] = [];
  if (outcome.removed > 0) {
    parts.push(`Removed ${plural(outcome.removed, "paper")} from “${topic.name}”.`);
  }
  // Journals PubMed carries but MEDLINE doesn't index. Topics are MeSH headings
  // and only MEDLINE-indexed records get them, so these match no topic however
  // long they are polled. Still worth keeping for a library built by PDF
  // import, which doesn't go through a topic at all — hence a warning, not a
  // refusal.
  if (outcome.unindexed.length > 0) {
    const one = outcome.unindexed.length === 1;
    parts.push(
      `MEDLINE doesn't index ${outcome.unindexed.join(", ")}. ` +
        `${one ? "Its papers carry" : "Their papers carry"} no MeSH headings, so ` +
        `${one ? "it" : "they"} can't match a topic and won't add anything to Interests.`
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

const sameJournals = (a: ListedJournal[], b: ListedJournal[]) =>
  a.length === b.length && a.every((j) => b.some((k) => k.nlm_id === j.nlm_id));

export function TopicDialog({
  open,
  topic: current,
  topics,
  onClose,
  onSaved,
}: {
  open: boolean;
  // The topic being edited, or null to create one.
  topic: Topic | null;
  // Every topic, for the lists that can be copied from.
  topics: Topic[];
  onClose: () => void;
  // The topic as the server stored it, and what saving it did. Called before
  // the dialog closes.
  onSaved: (topic: TopicDetail, outcome: TopicSaveOutcome) => void;
}) {
  // The topic this opening is about, kept through the close. The shell clears
  // its topic in the same update that closes the dialog, and the dialog stays
  // on screen after that for as long as its exit animation runs — as a dialog
  // for no topic, which is the New topic form. Cancel on an edit flashed that
  // form on the way out.
  const topic = useHeldWhile(open, current);

  const [headings, setHeadings] = useState<MeshDescriptorRef[]>([]);
  const [query, setQuery] = useState("");
  // The name box shows the headings' own name until someone types in it; from
  // then on it is theirs, and picking another heading no longer rewrites it.
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [allPubmed, setAllPubmed] = useState(true);
  const [journals, setJournals] = useState<ListedJournal[]>([]);
  // The stored scope of the topic being edited, once it has been fetched. Null
  // while it is on its way, and always for a topic being created.
  const [stored, setStored] = useState<{ allPubmed: boolean; journals: ListedJournal[] } | null>(
    null
  );
  const [suggested, setSuggested] = useState<TopicSuggestResponse>(NO_SUGGESTIONS);
  // The count, with the set of headings it was taken for: a reading for another
  // set is no answer for this one. `count` is null when PubMed couldn't say.
  const [preview, setPreview] = useState<{ key: string; count: number | null } | null>(null);
  // The confirmation ahead of a change that takes papers out. Built from a
  // count fetched before it opens, so it travels with its message.
  const [confirm, setConfirm] = useState<{ title: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Why the stored scope didn't come, when it didn't. Kept apart from `error`,
  // which the banner shows and anyone can dismiss: this one stands where the
  // journals would be, beside the button that asks again. `attempt` counts the
  // askings, so each is a run of the effect that fetches.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const editing = topic != null;

  // Each opening starts fresh, before paint, so the last use can't show through.
  useLayoutEffect(() => {
    if (!open) return;
    setHeadings([]);
    setQuery("");
    setName(topic?.name ?? "");
    setNameTouched(topic != null);
    // A new topic searches everything until told otherwise: with two headings
    // that is usually what it should do, and the count below says when not.
    setAllPubmed(topic ? topic.all_pubmed : true);
    setJournals([]);
    setStored(null);
    setPreview(null);
    setConfirm(null);
    setSaving(false);
    setError(null);
    setLoadError(null);
    // Keyed on which topic, not on the object: the shell reloads its topics
    // when a check for new papers lands, which hands this a new object for the
    // same topic and would otherwise wipe a name half typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, topic?.id]);

  // The list a topic already has. Fetched here rather than carried on every
  // topic: only this dialog reads it.
  const topicId = topic?.id;
  useEffect(() => {
    if (!open || topicId == null) return;
    let active = true;
    api
      .getTopic(topicId)
      .then((detail) => {
        if (!active) return;
        const list = detail.journals.flatMap((j) => listedFromStored(j) ?? []);
        setStored({ allPubmed: detail.all_pubmed, journals: list });
        setAllPubmed(detail.all_pubmed);
        setJournals(list);
      })
      .catch((e) => active && setLoadError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, [open, topicId, attempt]);

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

  // Counted a moment after the headings settle rather than on every pick. The
  // wait is this effect's own timer, so it is dropped with the headings it was
  // started for: a debounced copy of the key outlived them, and an opening,
  // which begins by clearing the last one's headings, still asked PubMed about
  // those.
  const key = headings.map((h) => h.ui).join(",");
  useEffect(() => {
    if (!open || editing || key === "") return;
    let active = true;
    const timer = setTimeout(() => {
      api
        .previewTopic(key.split(","))
        .then((r) => active && setPreview({ key, count: r.count }))
        // A count that can't be had is not a reason to refuse the topic.
        .catch(() => active && setPreview({ key, count: null }));
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, open, editing]);

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

  // The headings the journal panes ask Auto about: the ones being picked, or
  // the ones the topic has.
  const shownHeadings = topic ? topic.headings : headings;
  const scope: TopicScopeInput = {
    allPubmed,
    journals: allPubmed ? [] : journals.map((j) => j.nlm_id),
  };
  const renamed = topic != null && typedName !== topic.name;
  const rescoped =
    stored != null &&
    (allPubmed !== stored.allPubmed || (!allPubmed && !sameJournals(journals, stored.journals)));
  // The stored scope of the topic being edited isn't here: on its way, or it
  // didn't come. It replaces whatever the dialog shows when it lands, so until
  // then the scope is held still: a radio switched or a journal added first
  // would be put back.
  const unscoped = topic != null && stored == null;
  // On its way, which is not the same as not coming: a load that failed used to
  // read as one that never ended.
  const loading = unscoped && loadError == null;

  // A name can be saved without the stored scope: `rescoped` is false until it
  // arrives, so that request carries the name and nothing else.
  const canSave = topic
    ? typedName !== "" && (renamed || rescoped)
    : headings.length > 0;

  async function commit() {
    setConfirm(null);
    setSaving(true);
    setError(null);
    try {
      let saved: TopicDetail;
      let removed = 0;
      if (topic) {
        const change = renamed ? { name: typedName } : {};
        const res = await api.updateTopic(topic.id, rescoped ? { ...change, ...scope } : change);
        saved = res.topic;
        removed = res.removed.removedFromInterests;
      } else {
        // A name nobody typed is left for the server to give, so the two can't
        // drift; a blanked box asks for the same thing.
        saved = await api.createTopic(
          headings.map((h) => h.ui),
          scope,
          nameTouched && typedName !== "" ? typedName : undefined
        );
      }
      // Only the journals this save listed: one already on the topic said its
      // piece when it was added.
      const before = new Set((stored?.journals ?? []).map((j) => j.nlm_id));
      const unindexed = saved.journals
        .filter((j) => j.medline_indexed === false && !(j.nlm_id && before.has(j.nlm_id)))
        .map((j) => j.name);
      onSaved(saved, { created: topic == null, removed, unindexed });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving || !canSave) return;
    if (!topic || !rescoped || !stored) return commit();
    // Papers leave only when the scope narrows, and how many is the server's to
    // say — it reads the same query the change itself runs.
    setSaving(true);
    setError(null);
    let count: number;
    try {
      count = (await api.scopeChangeCount(topic.id, scope)).count;
    } catch (err) {
      // Not waved through as zero: the answer decides whether to ask first.
      setError(errorMessage(err));
      setSaving(false);
      return;
    }
    setSaving(false);
    if (count === 0) return commit();
    const dropped = stored.allPubmed
      ? 0
      : stored.journals.filter((j) => !journals.some((k) => k.nlm_id === j.nlm_id)).length;
    setConfirm({
      title: stored.allPubmed
        ? "Search only these journals?"
        : `Remove ${dropped} journal${dropped === 1 ? "" : "s"} from this topic?`,
      message: `This will remove ${
        stored.allPubmed ? "" : dropped === 1 ? "its " : "their "
      }${count.toLocaleString()} stored paper${count === 1 ? "" : "s"} from “${topic.name}”.`,
    });
  }

  // One line, always present — empty until there is a heading to count — so
  // the dialog is the same height whatever it says.
  const counted = preview && preview.key === key ? preview : null;
  const overCap = counted?.count != null && counted.count > PUBMED_MAX_RESULTS;
  const countLine =
    headings.length === 0 ? null : !counted ? (
      "Counting matches…"
    ) : counted.count == null ? (
      "Couldn't count matches just now."
    ) : (
      <>
        <strong>{counted.count.toLocaleString()}</strong> {counted.count === 1 ? "paper" : "papers"}{" "}
        in PubMed {counted.count === 1 ? "matches" : "match"}
        {overCap &&
          `, more than the ${PUBMED_MAX_RESULTS.toLocaleString()} one search returns. ` +
            "Add a heading to narrow it, or choose journals."}
      </>
    );

  return (
    <>
      <ModalShell
        wide
        open={open}
        onClose={() => !saving && onClose()}
        title={topic ? "Edit topic" : "New topic"}
      >
        <form className="topic-form" onSubmit={save}>
          <Banner kind="error" message={error} onDismiss={() => setError(null)} />

          {/* The icon here is the dialog's first tab stop, and Radix opens a
              dialog on its first tab stop — so the field it explains, the
              heading search for a new topic and the name for one being edited,
              takes the focus itself with autoFocus, which Radix leaves alone. */}
          <div className="topic-label first">
            <span id="topic-headings-label">MeSH headings</span>
            <InfoTip text={topic ? FIXED : ALL_REQUIRED} />
          </div>
          <div className={`topic-headings${topic ? " fixed" : ""}`}>
            {shownHeadings.length > 0 && (
              <ul className="topic-chips" aria-labelledby="topic-headings-label">
                {shownHeadings.map((h) => (
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
                autoFocus
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
            autoFocus={topic != null}
            value={shownName}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder={autoName || "Topic name"}
            maxLength={MAX_TOPIC_NAME_CHARS}
          />

          <div className="topic-label" id="topic-scope-label">
            Journals
          </div>
          <div className="topic-scope" role="radiogroup" aria-labelledby="topic-scope-label">
            <label>
              <input
                type="radio"
                name="topic-scope"
                checked={allPubmed}
                onChange={() => setAllPubmed(true)}
                disabled={saving || unscoped}
              />
              All of PubMed
            </label>
            <label>
              <input
                type="radio"
                name="topic-scope"
                checked={!allPubmed}
                onChange={() => setAllPubmed(false)}
                disabled={saving || unscoped}
              />
              Only these journals
            </label>
          </div>
          {/* In the journals' place, not above empty panes: "No journals chosen
              yet." is a claim about the topic, and a request that never
              answered is no ground for it. */}
          {loadError != null && (
            <p className="topic-scope-failed" role="alert">
              Couldn’t load this topic’s journals: {loadError}{" "}
              <button
                type="button"
                onClick={() => {
                  setLoadError(null);
                  setAttempt((n) => n + 1);
                }}
                disabled={saving}
              >
                Try again
              </button>
            </p>
          )}
          {!allPubmed && loadError == null && (
            <JournalPanes
              original={stored?.journals ?? []}
              value={journals}
              onChange={setJournals}
              headings={shownHeadings}
              copyFrom={topics.filter((t) => t.id !== topic?.id && t.journalCount > 0)}
              loading={loading}
              disabled={saving || loading}
            />
          )}

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

      <ConfirmDialog
        open={confirm != null}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        confirmLabel="Remove"
        danger
        onConfirm={commit}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
