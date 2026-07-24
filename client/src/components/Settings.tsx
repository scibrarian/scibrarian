import { FormEvent, useEffect, useState } from "react";
import { Search, Share2, Check } from "lucide-react";
import { api } from "../api";
import { copyTextToClipboard } from "../lib/clipboard";
import { errorMessage, round1 } from "../lib/format";
import { Banner } from "./Banner";
import { ConfirmDialog } from "./Dialogs";
import { JournalManager } from "./JournalManager";
import { ListRowSkeleton, SkeletonBar, StackedFormSkeleton } from "./Skeleton";
import { Typeahead } from "./Typeahead";
import type { AppSettings, Topic, Journal, MeshSearchResult } from "../types";

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
  // The last-persisted settings, held so the "Save settings" button can tell
  // whether the form has unsaved edits. Kept in step with `settings` wherever
  // the server confirms a write (initial load and a successful save).
  const [baseline, setBaseline] = useState<AppSettings | null>(null);
  // False only until the first reload settles — the panels show skeletons
  // instead of misleading "No journals yet." empty states and a form that pops
  // in. Later reloads (after mutations) keep showing the current data.
  const [loaded, setLoaded] = useState(false);

  const [topicQuery, setTopicQuery] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // Journal add/remove lives in the JournalManager dialog.
  const [managingJournals, setManagingJournals] = useState(false);
  // The topic warning depends on an article count fetched *before* the dialog
  // opens, so the pending removal carries its message along.
  const [topicToRemove, setTopicToRemove] = useState<{ topic: Topic; message: string } | null>(null);

  function reload() {
    Promise.all([api.getJournals(), api.getTopics(), api.getSettings()])
      .then(([j, d, s]) => {
        setJournals(j);
        setTopics(d);
        setSettings(s);
        setBaseline(s);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }

  useEffect(reload, []);

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

  async function askRemoveTopic(d: Topic) {
    setError(null);
    let count = 0;
    try {
      count = (await api.topicArticleCount(d.id)).count;
    } catch {
      /* if the count lookup fails, fall through with the gentle warning */
    }
    const message =
      count > 0
        ? `This will permanently delete ${count} stored paper${
            count === 1 ? "" : "s"
          }. Papers that also appear under other topics, or are saved in your Library, are kept. This cannot be undone.`
        : "No stored papers are exclusive to this topic — papers under other topics and in your Library are kept.";
    setTopicToRemove({ topic: d, message });
  }

  async function removeTopic() {
    if (!topicToRemove) return;
    setTopicToRemove(null);
    try {
      const res = await api.deleteTopic(topicToRemove.topic.id);
      reload();
      onDataChanged();
      if (res.deletedArticles > 0) onPapersRemoved(res.deletedArticles);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copyUrl(url: string) {
    try {
      await copyTextToClipboard(url);
    } catch {
      return; // Copy blocked — skip the "Copied ✓" flash rather than claim success.
    }
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
      // Patch only library_open from the server response — replacing the whole
      // object would clobber unsaved edits in the settings form. Baseline tracks
      // the same field so the "Save settings" dirty check stays accurate.
      setSettings((s) => (s ? { ...s, library_open: updated.library_open } : updated));
      setBaseline((b) => (b ? { ...b, library_open: updated.library_open } : updated));
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
      setBaseline(updated);
      setApiKey("");
      setSavedMsg("Settings saved.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // Enable "Save settings" only when the form differs from what's persisted.
  // The API key is write-only (never read back from the server), so any entry
  // there always counts as a change.
  const settingsDirty =
    settings != null &&
    baseline != null &&
    (settings.ncbi_email !== baseline.ncbi_email ||
      settings.poll_cron !== baseline.poll_cron ||
      settings.poll_enabled !== baseline.poll_enabled ||
      apiKey.trim() !== "");

  return (
    <div className="settings">
      {error && <Banner kind="error" message={error} onDismiss={() => setError(null)} />}

      <section className="panel">
        <h2>Journals</h2>
        <p className="hint">
          Papers from these journals feed your Interests topics. The number is OpenAlex 2-yr
          citations per article — an open stand-in for impact factor.
        </p>
        <button type="button" className="accent-btn" onClick={() => setManagingJournals(true)}>
          Manage journals…
        </button>
        <ul className="list scroll-list">
          {!loaded ? (
            // Six rows to match the fixed height, so the panel doesn't resize on load.
            ["30%", "42%", "35%", "28%", "38%", "33%"].map((w, i) => (
              <ListRowSkeleton key={i} w={w} pill />
            ))
          ) : (
            <>
              {journals.map((j) => (
                <li key={j.id}>
                  <span>{j.name}</span>
                  {j.metric != null && (
                    <span
                      className={`ta-metric${j.metric === 0 ? " zero" : ""}`}
                      title="OpenAlex 2-yr citations per article"
                    >
                      {round1(j.metric)}
                    </span>
                  )}
                </li>
              ))}
              {journals.length === 0 && <li className="muted">No journals yet.</li>}
            </>
          )}
        </ul>
      </section>

      <section className="panel">
        <h2>Topics</h2>
        <p className="hint">
          Each topic appears under{" "}
          <strong><Search size={14} className="inline-icon" aria-hidden /> Interests</strong>. Search the{" "}
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
          {!loaded ? (
            [0, 1].map((i) => <ListRowSkeleton key={i} w={["55%", "40%"][i]} />)
          ) : (
            <>
              {topics.map((d) => (
                <li key={d.id}>
                  <span>
                    <strong>{d.name}</strong>
                    <code className="term">{d.term}</code>
                  </span>
                  <button className="link-btn danger" onClick={() => askRemoveTopic(d)}>
                    Remove
                  </button>
                </li>
              ))}
              {topics.length === 0 && <li className="muted">No topics yet.</li>}
            </>
          )}
        </ul>
      </section>

      <section className="panel">
        <h2>Polling & NCBI</h2>
        {savedMsg && <Banner kind="success" message={savedMsg} onDismiss={() => setSavedMsg(null)} />}
        {!loaded && <StackedFormSkeleton />}
        {loaded && settings && (
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
                  “Check for new papers” works either way.
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
              NCBI API key {settings.has_api_key && <span className="pill">set <Check size={12} className="inline-icon" aria-hidden /></span>}
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
            <button type="submit" disabled={!settingsDirty}>
              Save settings
            </button>
          </form>
        )}
      </section>

      <section className="panel">
        <h2>Sharing</h2>
        {!loaded && (
          <p className="hint" aria-busy="true" aria-label="Loading sharing info">
            <SkeletonBar w="85%" h={12} style={{ marginBottom: 6 }} />
            <SkeletonBar w="60%" h={12} />
          </p>
        )}
        {loaded && settings &&
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
                everything except stored PDFs — share those with the{" "}
                <Share2 size={14} className="inline-icon" aria-hidden /> buttons, or turn
                on Open Library below. Changing anything still requires the admin token.
              </p>
              <ul className="list">
                {settings.share_urls.map((url) => (
                  <li key={url}>
                    <span>
                      <code>{url}</code>
                    </span>
                    <button className="link-btn" onClick={() => copyUrl(url)}>
                      {copiedUrl === url ? <>Copied <Check size={13} className="inline-icon" aria-hidden /></> : "Copy"}
                    </button>
                  </li>
                ))}
              </ul>
              <label className="open-library">
                <span>
                  Open Library {librarySaved && <span className="pill">Saved <Check size={12} className="inline-icon" aria-hidden /></span>}
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

      <JournalManager
        open={managingJournals}
        onClose={() => setManagingJournals(false)}
        onCommitted={(papersRemoved, removalsHappened) => {
          reload();
          onDataChanged();
          if (removalsHappened) onPapersRemoved(papersRemoved);
        }}
      />
      <ConfirmDialog
        open={topicToRemove != null}
        title={topicToRemove ? `Remove "${topicToRemove.topic.name}"?` : ""}
        message={topicToRemove?.message ?? ""}
        confirmLabel="Remove"
        danger
        onConfirm={removeTopic}
        onCancel={() => setTopicToRemove(null)}
      />
    </div>
  );
}
