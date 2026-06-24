import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings, Disease, Journal } from "../types";

export function Settings({ onDataChanged }: { onDataChanged: () => void }) {
  const [journals, setJournals] = useState<Journal[]>([]);
  const [diseases, setDiseases] = useState<Disease[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const [journalName, setJournalName] = useState("");
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

  async function addJournal(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const name = journalName.trim();
    if (!name) return;
    try {
      await api.createJournal(name);
      setJournalName("");
      reload();
      onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeJournal(id: number) {
    await api.deleteJournal(id);
    reload();
    onDataChanged();
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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="settings">
      {error && <div className="banner error">{error}</div>}

      <section className="panel">
        <h2>Journals</h2>
        <p className="hint">
          Journals to watch. Type the journal name or its standard abbreviation (PubMed
          recognizes both), e.g. <em>New England Journal of Medicine</em> or <em>Lancet</em>.
        </p>
        <form className="inline-form" onSubmit={addJournal}>
          <input
            value={journalName}
            onChange={(e) => setJournalName(e.target.value)}
            placeholder="Add a journal…"
          />
          <button type="submit">Add</button>
        </form>
        <ul className="list">
          {journals.map((j) => (
            <li key={j.id}>
              <span>{j.name}</span>
              <button className="link-btn danger" onClick={() => removeJournal(j.id)}>
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
          Each disease becomes a tab. The <strong>PubMed term</strong> can be a MeSH heading
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
