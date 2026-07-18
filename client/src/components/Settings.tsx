import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { copyTextToClipboard } from "../lib/clipboard";
import { errorMessage } from "../lib/format";
import { Banner } from "./Banner";
import { ConfirmDialog } from "./Dialogs";
import { Typeahead } from "./Typeahead";
import type { AppSettings, Topic, Journal, JournalSearchResult, MeshSearchResult } from "../types";

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
  const [topicQuery, setTopicQuery] = useState("");
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

  async function addJournal(name: string) {
    setError(null);
    const n = name.trim();
    if (!n) return;
    try {
      await api.createJournal(n);
      setJournalName("");
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

  // `name` is a MeSH heading — picked from the autocomplete, or typed and
  // submitted (the server validates it and rejects anything that isn't a real
  // heading, so we don't need to gate it here).
  async function addTopic(name: string) {
    setError(null);
    const n = name.trim();
    if (!n) return;
    try {
      await api.createTopic(n);
      setTopicQuery("");
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
      {error && <Banner kind="error" message={error} onDismiss={() => setError(null)} />}

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
          <Typeahead<JournalSearchResult>
            value={journalName}
            onChange={setJournalName}
            search={(q) => api.searchJournals(q).then((r) => r.results)}
            onSelect={(r) => addJournal(r.abbr || r.title)}
            getKey={(r) => r.issn || r.title}
            placeholder="Search journals (e.g. lancet, n engl j med)…"
            id="journal-typeahead"
            renderItem={(r) => (
              <>
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
              </>
            )}
          />
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
          Each topic appears under <strong>🔍 Interests</strong>. Search the{" "}
          <strong>MeSH</strong> vocabulary and pick a heading — typing a synonym
          (e.g. <code>type 2 diabetes</code> or <code>NIDDM</code>) finds the official
          term (<code>Diabetes Mellitus, Type 2</code>). PubMed is searched by that MeSH heading.
        </p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            addTopic(topicQuery);
          }}
        >
          <Typeahead<MeshSearchResult>
            value={topicQuery}
            onChange={setTopicQuery}
            search={(q) => api.searchMesh(q).then((r) => r.results)}
            onSelect={(m) => addTopic(m.name)}
            getKey={(m) => m.ui}
            placeholder="Search MeSH terms (e.g. type 2 diabetes)…"
            id="topic-typeahead"
            renderItem={(m) => <span className="ta-title">{m.name}</span>}
          />
          <button type="submit">Add</button>
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
        {savedMsg && <Banner kind="success" message={savedMsg} onDismiss={() => setSavedMsg(null)} />}
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
