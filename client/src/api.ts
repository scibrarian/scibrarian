import type {
  AppSettings,
  ArticlesResponse,
  Disease,
  GraphResponse,
  Journal,
  JournalSearchResponse,
  RefreshResponse,
} from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  getDiseases: () => req<Disease[]>("/api/diseases"),
  createDisease: (name: string, term: string) =>
    req<Disease>("/api/diseases", { method: "POST", body: JSON.stringify({ name, term }) }),
  deleteDisease: (id: number) => req<void>(`/api/diseases/${id}`, { method: "DELETE" }),

  getJournals: () => req<Journal[]>("/api/journals"),
  searchJournals: (q: string) =>
    req<JournalSearchResponse>(`/api/journals/search?q=${encodeURIComponent(q)}`),
  createJournal: (name: string) =>
    req<Journal>("/api/journals", { method: "POST", body: JSON.stringify({ name }) }),
  journalArticleCount: (id: number) =>
    req<{ count: number }>(`/api/journals/${id}/article-count`),
  deleteJournal: (id: number) =>
    req<{ deletedArticles: number }>(`/api/journals/${id}`, { method: "DELETE" }),

  getArticles: (diseaseId: number, journal?: string, q?: string) => {
    const params = new URLSearchParams({ disease: String(diseaseId) });
    if (journal) params.set("journal", journal);
    if (q) params.set("q", q);
    return req<ArticlesResponse>(`/api/articles?${params.toString()}`);
  },

  getGraph: (diseaseId: number) => req<GraphResponse>(`/api/graph?disease=${diseaseId}`),

  refresh: (diseaseId?: number) => {
    const suffix = diseaseId ? `?disease=${diseaseId}` : "";
    return req<RefreshResponse>(`/api/refresh${suffix}`, { method: "POST" });
  },

  getSettings: () => req<AppSettings>("/api/settings"),
  updateSettings: (s: Partial<AppSettings> & { ncbi_api_key?: string }) =>
    req<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
};
