import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { errorMessage } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import type { AppSettings, Disease, Journal, JournalSearchResult } from "../types";

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

export function Settings({ onDataChanged }: { onDataChanged: () => void }) {
  const [journals, setJournals] = useState<Journal[]>([]);
  const [diseases, setDiseases] = useState<Disease[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const [journalName, setJournalName] = useState("");
  const [journalResults, setJournalResults] = useState<JournalSearchResult[]>([]);
  const [diseaseName, setDiseaseName] = useState("");
  const [diseaseTerm, setDiseaseTerm] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  function reload() {
    Promise.all([api.getJournals(), api.getDiseases(), api.getSettings()])
      .then(([j, d, s]) => {
        setJournals(j);
        setDiseases(d);
        setSettings(s);
      })
      .catch((e) => setError(e.message));
  }

  useEffect(reload, []);

  // Debounced journal autocomplete against the local NLM catalog.
  const journalQuery = useDebounced(journalName.trim(), 200);
  useEffect(() => {
    if (journalQuery.length < 2) {
      setJournalResults([]);
      return;
    }
    api
      .searchJournals(journalQuery)
      .then((r) => setJournalResults(r.results))
      .catch(() => setJournalResults([]));
  }, [journalQuery]);

  async function addJournal(name: string) {
    setError(null);
    const n = name.trim();
    if (!n) return;
    try {
      await api.createJournal(n);
      setJournalName("");
      setJournalResults([]);
      reload();
      onDataChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeJournal(j: Journal) {
    setError(null);
    let count = 0;
    try {
      count = (await api.journalArticleCount(j.id)).count;
    } catch {
      /* if the count lookup fails, fall through with a generic warning */
    }
    const warning =
      count > 0
        ? `Remove "${j.name}"?\n\nThis will also permanently delete ${count} stored paper${
            count === 1 ? "" : "s"
          } from this journal, across all diseases. This cannot be undone.`
        : `Remove "${j.name}"? No stored papers are linked to it.`;
    if (!window.confirm(warning)) return;
    try {
      await api.deleteJournal(j.id);
      reload();
      onDataChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function addDisease(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const name = diseaseName.trim();
    const term = diseaseTerm.trim();
    if (!name || !term) {
      setError("A disease needs both a name and a PubMed search term.");
      return;
    }
    try {
      await api.createDisease(name, term);
      setDiseaseName("");
      setDiseaseTerm("");
      reload();
      onDataChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeDisease(id: number) {
    if (!confirm("Remove this disease and its timeline links? (Papers stay in the database.)")) {
      return;
    }
    await api.deleteDisease(id);
    reload();
    onDataChanged();
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
          <div className="typeahead">
            <input
              value={journalName}
              onChange={(e) => setJournalName(e.target.value)}
              placeholder="Search journals (e.g. lancet, n engl j med)…"
              autoComplete="off"
            />
            {journalResults.length > 0 && (
              <ul className="typeahead-list">
                {journalResults.map((r) => (
                  <li key={r.issn || r.title}>
                    <button
                      type="button"
                      className="typeahead-item"
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
              <button className="link-btn danger" onClick={() => removeJournal(j)}>
                Remove
              </button>
            </li>
          ))}
          {journals.length === 0 && <li className="muted">No journals yet.</li>}
        </ul>
      </section>

      <section className="panel">
        <h2>Diseases</h2>
        <p className="hint">
          Each disease becomes a topic in <strong>🔍 Discover</strong>. The{" "}
          <strong>PubMed term</strong> can be a MeSH heading
          like <code>"diabetes mellitus, type 2"[MeSH]</code> or plain keywords like{" "}
          <code>alzheimer disease</code>. MeSH terms are more precise.
        </p>
        <form className="stacked-form" onSubmit={addDisease}>
          <input
            value={diseaseName}
            onChange={(e) => setDiseaseName(e.target.value)}
            placeholder="Display name (e.g. Type 2 Diabetes)"
          />
          <input
            value={diseaseTerm}
            onChange={(e) => setDiseaseTerm(e.target.value)}
            placeholder='PubMed term (e.g. "diabetes mellitus, type 2"[MeSH])'
          />
          <button type="submit">Add disease</button>
        </form>
        <ul className="list">
          {diseases.map((d) => (
            <li key={d.id}>
              <span>
                <strong>{d.name}</strong>
                <code className="term">{d.term}</code>
              </span>
              <button className="link-btn danger" onClick={() => removeDisease(d.id)}>
                Remove
              </button>
            </li>
          ))}
          {diseases.length === 0 && <li className="muted">No diseases yet.</li>}
        </ul>
      </section>

      <section className="panel">
        <h2>Polling & NCBI</h2>
        {savedMsg && <div className="banner success">{savedMsg}</div>}
        {settings && (
          <form className="stacked-form" onSubmit={saveSettings}>
            <label>
              Poll schedule (cron)
              <input
                value={settings.poll_cron}
                onChange={(e) => setSettings({ ...settings, poll_cron: e.target.value })}
              />
              <span className="hint">
                Default <code>0 6 * * *</code> = daily at 6am. Format: min hour day month weekday.
              </span>
            </label>
            <label>
              Contact email (sent to NCBI per their usage policy)
              <input
                value={settings.ncbi_email}
                onChange={(e) => setSettings({ ...settings, ncbi_email: e.target.value })}
              />
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
    </div>
  );
}
