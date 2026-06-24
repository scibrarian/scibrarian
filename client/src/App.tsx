import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Disease } from "./types";
import { TabBar } from "./components/TabBar";
import { Timeline } from "./components/Timeline";
import { Settings } from "./components/Settings";

export default function App() {
  const [diseases, setDiseases] = useState<Disease[]>([]);
  const [active, setActive] = useState<number | "settings">("settings");
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  function loadDiseases(): Promise<Disease[]> {
    return api
      .getDiseases()
      .then((ds) => {
        setDiseases(ds);
        setLoaded(true);
        return ds;
      })
      .catch(() => {
        setLoaded(true);
        return [];
      });
  }

  useEffect(() => {
    loadDiseases().then((ds) => {
      if (ds.length > 0) setActive(ds[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeDisease = useMemo(
    () => (typeof active === "number" ? diseases.find((d) => d.id === active) ?? null : null),
    [active, diseases]
  );

  async function handleRefresh() {
    setRefreshing(true);
    setStatus(null);
    try {
      const diseaseId = typeof active === "number" ? active : undefined;
      const res = await api.refresh(diseaseId);
      const added = res.results.reduce((s, r) => s + r.added, 0);
      const errs = res.results.filter((r) => r.error);
      let msg = `Added ${added} new paper${added === 1 ? "" : "s"}.`;
      if (errs.length) msg += ` ${errs.length} error(s): ${errs.map((e) => e.error).join("; ")}`;
      setStatus(msg);
      await loadDiseases();
      setReloadToken((t) => t + 1);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">🧬</span>
          <h1>Research Timeline</h1>
        </div>
        <div className="header-actions">
          {activeDisease?.last_polled_at && (
            <span className="updated">Updated {timeAgo(activeDisease.last_polled_at)}</span>
          )}
          <button className="refresh-btn" onClick={handleRefresh} disabled={refreshing}>
            {refreshing
              ? "Refreshing…"
              : typeof active === "number"
                ? "Refresh now"
                : "Refresh all"}
          </button>
        </div>
      </header>

      <TabBar diseases={diseases} active={active} onSelect={setActive} />

      {status && <div className="banner info">{status}</div>}

      <main className="app-main">
        {!loaded ? (
          <div className="empty">Loading…</div>
        ) : active === "settings" ? (
          <Settings onDataChanged={loadDiseases} />
        ) : activeDisease ? (
          <Timeline diseaseId={activeDisease.id} reloadToken={reloadToken} />
        ) : (
          <div className="empty">
            No diseases yet. Open <strong>⚙ Settings</strong> to add journals and diseases.
          </div>
        )}
      </main>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
