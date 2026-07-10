import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { errorMessage } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import { ConfirmDialog } from "./Dialogs";
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
  const [diseases, setDiseases] = useState<Disease[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const [journalName, setJournalName] = useState("");
  const [journalResults, setJournalResults] = useState<JournalSearchResult[]>([]);
  // The results list is a combobox popup: it hides on Escape/blur (dismissed)
  // without discarding the fetched results, and reopens on typing or refocus.
  const [listDismissed, setListDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const [diseaseName, setDiseaseName] = useState("");
  const [diseaseTerm, setDiseaseTerm] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // The journal warning depends on an article count fetched *before* the
  // dialog opens, so the pending removal carries its message along.
  const [journalToRemove, setJournalToRemove] = useState<{ journal: Journal; message: string } | null>(null);
  const [diseaseToRemove, setDiseaseToRemove] = useState<number | null>(null);

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
    setActiveIndex(-1);
    if (journalQuery.length < 2) {
      setJournalResults([]);
      return;
    }
    api
      .searchJournals(journalQuery)
      .then((r) => setJournalResults(r.results))
      .catch(() => setJournalResults([]));
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

  async function removeDisease() {
    if (diseaseToRemove == null) return;
    setDiseaseToRemove(null);
    try {
      await api.deleteDisease(diseaseToRemove);
      reload();
      onDataChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // navigator.clipboard needs a secure context (HTTPS or localhost); fall
      // back to the legacy path when the app is served over plain LAN HTTP.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl((cur) => (cur === url ? null : cur)), 2000);
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
        <h2>Diseases</h2>
        <p className="hint">
          Each disease becomes a topic in <strong>🔍 Interests</strong>. The{" "}
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
              <button className="link-btn danger" onClick={() => setDiseaseToRemove(d.id)}>
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
                everything; changing anything still requires the admin token.
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
        open={diseaseToRemove != null}
        title="Remove this disease?"
        message="Its timeline links are removed too. Papers stay in the database."
        confirmLabel="Remove"
        danger
        onConfirm={removeDisease}
        onCancel={() => setDiseaseToRemove(null)}
      />
    </div>
  );
}
