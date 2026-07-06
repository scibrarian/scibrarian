import type {
  AppSettings,
  ArticlesResponse,
  Collection,
  CollectionFile,
  CollectionPapersResponse,
  Disease,
  FsListing,
  FsRootsResponse,
  GraphResponse,
  GraphSource,
  ImportStartResponse,
  ImportStatus,
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

  getGraph: (source: GraphSource) => {
    const qs =
      "disease" in source ? `disease=${source.disease}` : `collection=${source.collection}`;
    return req<GraphResponse>(`/api/graph?${qs}`);
  },

  getCollections: () => req<Collection[]>("/api/collections"),
  createCollection: (name: string) =>
    req<Collection>("/api/collections", { method: "POST", body: JSON.stringify({ name }) }),
  renameCollection: (id: number, name: string) =>
    req<Collection>(`/api/collections/${id}`, { method: "PUT", body: JSON.stringify({ name }) }),
  deleteCollection: (id: number) => req<void>(`/api/collections/${id}`, { method: "DELETE" }),
  getCollectionPapers: (id: number) =>
    req<CollectionPapersResponse>(`/api/collections/${id}/papers`),
  importIntoCollection: (id: number, paths: string[], recursive: boolean) =>
    req<ImportStartResponse>(`/api/collections/${id}/import`, {
      method: "POST",
      body: JSON.stringify({ paths, recursive }),
    }),
  getImportStatus: (id: number) => req<ImportStatus>(`/api/collections/${id}/import/status`),
  setFilePmid: (fileId: number, pmid: string) =>
    req<CollectionFile>(`/api/collections/files/${fileId}/pmid`, {
      method: "POST",
      body: JSON.stringify({ pmid }),
    }),
  deleteCollectionFile: (fileId: number) =>
    req<void>(`/api/collections/files/${fileId}`, { method: "DELETE" }),
  openFile: (fileId: number) =>
    req<void>("/api/open", { method: "POST", body: JSON.stringify({ fileId }) }),
  fsRoots: () => req<FsRootsResponse>("/api/fs/roots"),
  fsList: (path: string) => req<FsListing>(`/api/fs/list?path=${encodeURIComponent(path)}`),

  refresh: (diseaseId?: number) => {
    const suffix = diseaseId ? `?disease=${diseaseId}` : "";
    return req<RefreshResponse>(`/api/refresh${suffix}`, { method: "POST" });
  },

  getSettings: () => req<AppSettings>("/api/settings"),
  updateSettings: (s: Partial<AppSettings> & { ncbi_api_key?: string }) =>
    req<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
};
