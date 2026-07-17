import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { copyTextToClipboard } from "../lib/clipboard";
import { errorMessage } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import { ConfirmDialog } from "./Dialogs";
import type { AppSettings, Topic, Journal, JournalSearchResult } from "../types";

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "in", "nor",
  "of", "on", "or", "the", "to", "via", "vs", "with",
]);

// NLM stores titles in sentence case ("Cell metabolism"); show them title-cased
// ("Cell Metabolism"). Words that already contain a capital (acronyms like HIV,
// JAMA, or "(London,") are left untouched; small words stay lowercase mid-title.
function titleCaseJournal(s: string): string {
  return s
    .split(" ")
    .map((w, i) => {
      if (!w || /[A-Z]/.test(w)) return w;
      if (i > 0 && SMALL_WORDS.has(w.replace(/[^a-z]/g, ""))) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

export function Settings({
  onDataChanged,
  onPapersRemoved,
}: {
  onDataChanged: () => void;
  // Papers left the Interests feeds (journal removal): the app refreshes the
  // paper views and reports the count.
  onPapersRemoved: (count: number) => void;
}) {
  const [journals, setJournals] = useState<Journal[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const [journalName, setJournalName] = useState("");
  const [journalResults, setJournalResults] = useState<JournalSearchResult[]>([]);
  // The results list is a combobox popup: it hides on Escape/blur (dismissed)
  // without discarding the fetched results, and reopens on typing or refocus.
  const [listDismissed, setListDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const [topicName, setTopicName] = useState("");
  const [topicTerm, setTopicTerm] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // The journal warning depends on an article count fetched *before* the
  // dialog opens, so the pending removal carries its message along.
  const [journalToRemove, setJournalToRemove] = useState<{ journal: Journal; message: string } | null>(null);
  const [topicToRemove, setTopicToRemove] = useState<number | null>(null);

  function reload() {
    Promise.all([api.getJournals(), api.getTopics(), api.getSettings()])
      .then(([j, d, s]) => {
        setJournals(j);
        setTopics(d);
        setSettings(s);
      })
      .catch((e) => setError(e.message));
  }

  useEffect(reload, []);

  // Debounced journal autocomplete against the local NLM catalog.
  const journalQuery = useDebounced(journalName.trim(), 200);
  useEffect(() => {
    setActiveIndex(-1);
    if (journalQuery.length < 2) {
      setJournalResults([]);
      return;
    }
    // Guard against out-of-order responses: the cleanup runs before the next
    // query fires, so a slower earlier request can't overwrite newer results
    // (which would show options that don't match the input — you could add the
    // wrong journal).
    let active = true;
    api
      .searchJournals(journalQuery)
      .then((r) => {
        if (active) setJournalResults(r.results);
      })
      .catch(() => {
        if (active) setJournalResults([]);
      });
    return () => {
      active = false;
    };
  }, [journalQuery]);

  const listOpen = !listDismissed && journalResults.length > 0;

  // Keep the keyboard-highlighted option visible in the scrolling list.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function handleTypeaheadKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (listOpen) {
        e.preventDefault();
        setListDismissed(true);
        setActiveIndex(-1);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (journalResults.length === 0) return;
      e.preventDefault();
      if (!listOpen) {
        setListDismissed(false);
        setActiveIndex(e.key === "ArrowDown" ? 0 : journalResults.length - 1);
        return;
      }
      setActiveIndex((i) => {
        const n = journalResults.length;
        return e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    if (e.key === "Enter" && listOpen && activeIndex >= 0) {
      // Add the highlighted result, not the raw typed text the form would submit.
      e.preventDefault();
      const r = journalResults[activeIndex];
      addJournal(r.abbr || r.title);
    }
  }

  async function addJournal(name: string) {
    setError(null);
    const n = name.trim();
    if (!n) return;
    try {
      await api.createJournal(n);
      setJournalName("");
      setJournalResults([]);
      setActiveIndex(-1);
      setListDismissed(false);
      reload();
      onDataChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function askRemoveJournal(j: Journal) {
    setError(null);
    let count = 0;
    try {
      count = (await api.journalArticleCount(j.id)).count;
    } catch {
      /* if the count lookup fails, fall through with a generic warning */
    }
    const message =
      count > 0
        ? `This will remove its papers from Interests and permanently delete ${count} stored paper${
            count === 1 ? "" : "s"
          }. Papers saved in your Library are kept. This cannot be undone.`
        : "Its papers will be removed from Interests. Papers saved in your Library are kept.";
    setJournalToRemove({ journal: j, message });
  }

  async function removeJournal() {
    if (!journalToRemove) return;
    setJournalToRemove(null);
    try {
      const res = await api.deleteJournal(journalToRemove.journal.id);
      reload();
      onDataChanged();
      onPapersRemoved(res.removedFromInterests);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function addTopic(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const name = topicName.trim();
    const term = topicTerm.trim();
    if (!name || !term) {
      setError("A topic needs both a name and a PubMed search term.");
      return;
    }
    try {
      await api.createTopic(name, term);
      setTopicName("");
      setTopicTerm("");
      reload();
      onDataChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeTopic() {
    if (topicToRemove == null) return;
    setTopicToRemove(null);
    try {
      await api.deleteTopic(topicToRemove);
      reload();
      onDataChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copyUrl(url: string) {
    await copyTextToClipboard(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl((cur) => (cur === url ? null : cur)), 2000);
  }

  // The Open Library switch lives outside the settings form and saves
  // immediately; the PUT has patch semantics so only this key is sent.
  const [librarySaved, setLibrarySaved] = useState(false);
  async function toggleOpenLibrary(on: boolean) {
    if (!settings) return;
    const before = settings;
    setError(null);
    setSettings({ ...settings, library_open: on }); // optimistic; server confirms below
    try {
      const updated = await api.updateSettings({ library_open: on });
      setSettings(updated);
      setLibrarySaved(true);
      setTimeout(() => setLibrarySaved(false), 2000);
    } catch (err) {
      setSettings(before);
      setError(errorMessage(err));
    }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedMsg(null);
    if (!settings) return;
    try {
      const payload: Partial<AppSettings> & { ncbi_api_key?: string } = {
        ncbi_email: settings.ncbi_email,
        poll_cron: settings.poll_cron,
        poll_enabled: settings.poll_enabled,
      };
      if (apiKey.trim()) payload.ncbi_api_key = apiKey.trim();
      const updated = await api.updateSettings(payload);
      setSettings(updated);
      setApiKey("");
      setSavedMsg("Settings saved.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="settings">
      {error && <div className="banner error">{error}</div>}

      <section className="panel">
        <h2>Journals</h2>
        <p className="hint">
          Start typing to search journals, then pick one to add it by its official NLM
          abbreviation (what PubMed reliably matches). The number is OpenAlex 2-yr citations
          per article — an open stand-in for impact factor.
        </p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            addJournal(journalName);
          }}
        >
          <div
            className="typeahead"
            onBlur={(e) => {
              // focusout bubbles; only dismiss when focus leaves the whole
              // combobox (input + list), not when it moves between them.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setListDismissed(true);
                setActiveIndex(-1);
              }
            }}
          >
            <input
              value={journalName}
              onChange={(e) => {
                setJournalName(e.target.value);
                setListDismissed(false);
                setActiveIndex(-1);
              }}
              onKeyDown={handleTypeaheadKey}
              onFocus={() => setListDismissed(false)}
              placeholder="Search journals (e.g. lancet, n engl j med)…"
              autoComplete="off"
              role="combobox"
              aria-expanded={listOpen}
              aria-controls="journal-typeahead-list"
              aria-autocomplete="list"
              aria-activedescendant={
                listOpen && activeIndex >= 0 ? `journal-option-${activeIndex}` : undefined
              }
            />
            {listOpen && (
              <ul
                className="typeahead-list"
                id="journal-typeahead-list"
                role="listbox"
                ref={listRef}
                // Keep the input focused while clicking a result, so the blur
                // handler above can't unmount the list before the click lands.
                onMouseDown={(e) => e.preventDefault()}
              >
                {journalResults.map((r, i) => (
                  <li key={r.issn || r.title} role="presentation">
                    <button
                      type="button"
                      role="option"
                      id={`journal-option-${i}`}
                      aria-selected={i === activeIndex}
                      tabIndex={-1}
                      className={`typeahead-item${i === activeIndex ? " active" : ""}`}
                      onClick={() => addJournal(r.abbr || r.title)}
                    >
                      <span className="ta-title">{titleCaseJournal(r.title)}</span>
                      <span className="ta-meta">
                        {r.abbr && <span className="ta-abbr">{r.abbr}</span>}
                        {r.metric != null && (
                          <span
                            className={`ta-metric${r.metric === 0 ? " zero" : ""}`}
                            title="OpenAlex 2-yr citations per article"
                          >
                            {r.metric}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="submit">Add</button>
        </form>
        <ul className="list">
          {journals.map((j) => (
            <li key={j.id}>
              <span>{j.name}</span>
              <button className="link-btn danger" onClick={() => askRemoveJournal(j)}>
                Remove
              </button>
            </li>
          ))}
          {journals.length === 0 && <li className="muted">No journals yet.</li>}
        </ul>
      </section>

      <section className="panel">
        <h2>Topics</h2>
        <p className="hint">
          Each topic appears under <strong>🔍 Interests</strong>. The{" "}
          <strong>PubMed term</strong> can be a MeSH heading
          like <code>"diabetes mellitus, type 2"[MeSH]</code> or plain keywords like{" "}
          <code>alzheimer disease</code>. MeSH terms are more precise.
        </p>
        <form className="stacked-form" onSubmit={addTopic}>
          <input
            value={topicName}
            onChange={(e) => setTopicName(e.target.value)}
            placeholder="Display name (e.g. Type 2 Diabetes)"
          />
          <input
            value={topicTerm}
            onChange={(e) => setTopicTerm(e.target.value)}
            placeholder='PubMed term (e.g. "diabetes mellitus, type 2"[MeSH])'
          />
          <button type="submit">Add topic</button>
        </form>
        <ul className="list">
          {topics.map((d) => (
            <li key={d.id}>
              <span>
                <strong>{d.name}</strong>
                <code className="term">{d.term}</code>
              </span>
              <button className="link-btn danger" onClick={() => setTopicToRemove(d.id)}>
                Remove
              </button>
            </li>
          ))}
          {topics.length === 0 && <li className="muted">No topics yet.</li>}
        </ul>
      </section>

      <section className="panel">
        <h2>Polling & NCBI</h2>
        {savedMsg && <div className="banner success">{savedMsg}</div>}
        {settings && (
          <form className="stacked-form" onSubmit={saveSettings}>
            <label>
              Scheduled polling
              <span className="switch-row">
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={settings.poll_enabled}
                  onChange={(e) => setSettings({ ...settings, poll_enabled: e.target.checked })}
                />
                <span className="hint">
                  When on, every topic is checked for new papers on the schedule below.
                  “Refresh now” works either way.
                </span>
              </span>
            </label>
            <label>
              Poll schedule (cron)
              <input
                value={settings.poll_cron}
                onChange={(e) => setSettings({ ...settings, poll_cron: e.target.value })}
                disabled={!settings.poll_enabled}
              />
              <span className="hint">
                Default <code>0 6 * * *</code> = daily at 6am. Format: min hour day month weekday.
              </span>
            </label>
            <label>
              Contact email
              <input
                value={settings.ncbi_email}
                onChange={(e) => setSettings({ ...settings, ncbi_email: e.target.value })}
                placeholder="optional"
              />
              <span className="hint">
                Optional but recommended. Sent to NCBI and OpenAlex so they can contact you
                before blocking access if requests ever exceed their limits.
              </span>
            </label>
            <label>
              NCBI API key {settings.has_api_key && <span className="pill">set ✓</span>}
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.has_api_key ? "•••••• (leave blank to keep)" : "optional"}
              />
              <span className="hint">
                Optional. A free key raises the rate limit from ~3 to ~10 requests/sec.
              </span>
            </label>
            <button type="submit">Save settings</button>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Sharing</h2>
        {settings &&
          (settings.share_urls.length === 0 ? (
            <p className="hint">
              Only this machine can connect right now. To let others view your server, set{" "}
              <code>HOST</code> and <code>ADMIN_TOKEN</code> in <code>server/.env</code> and
              restart — see the README&rsquo;s &ldquo;Sharing your server&rdquo; section.
            </p>
          ) : (
            <>
              <p className="hint">
                Send one of these addresses to anyone on your network. They can view
                everything except stored PDFs — share those with the 🔗 buttons, or turn
                on Open Library below. Changing anything still requires the admin token.
              </p>
              <ul className="list">
                {settings.share_urls.map((url) => (
                  <li key={url}>
                    <span>
                      <code>{url}</code>
                    </span>
                    <button className="link-btn" onClick={() => copyUrl(url)}>
                      {copiedUrl === url ? "Copied ✓" : "Copy"}
                    </button>
                  </li>
                ))}
              </ul>
              <label className="open-library">
                <span>
                  Open Library {librarySaved && <span className="pill">Saved ✓</span>}
                </span>
                <span className="switch-row">
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch"
                    checked={settings.library_open}
                    onChange={(e) => toggleOpenLibrary(e.target.checked)}
                  />
                  <span className="hint">
                    When on, viewers can freely download stored files and collection zips —
                    no share link needed. When off, files are owner-only and shared via
                    expiring links.
                  </span>
                </span>
              </label>
            </>
          ))}
      </section>

      <ConfirmDialog
        open={journalToRemove != null}
        title={journalToRemove ? `Remove "${journalToRemove.journal.name}"?` : ""}
        message={journalToRemove?.message ?? ""}
        confirmLabel="Remove"
        danger
        onConfirm={removeJournal}
        onCancel={() => setJournalToRemove(null)}
      />
      <ConfirmDialog
        open={topicToRemove != null}
        title="Remove this topic?"
        message="Its timeline links are removed too. Papers stay in the database."
        confirmLabel="Remove"
        danger
        onConfirm={removeTopic}
        onCancel={() => setTopicToRemove(null)}
      />
    </div>
  );
}
