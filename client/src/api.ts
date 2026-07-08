import type {
  AppSettings,
  Collection,
  CollectionFile,
  CollectionFilesResponse,
  Disease,
  GraphResponse,
  ImportStartResponse,
  ImportStatus,
  Journal,
  JournalSearchResponse,
  PaperSource,
  PapersResponse,
  RefreshResponse,
  UploadResponse,
} from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    // FormData bodies must set their own multipart boundary header.
    headers: init?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
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

// The query param naming both source-driven endpoints share.
function sourceQuery(source: PaperSource): string {
  return "disease" in source ? `disease=${source.disease}` : `collection=${source.collection}`;
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

  getPapers: (source: PaperSource, q?: string) => {
    const qs = sourceQuery(source) + (q ? `&q=${encodeURIComponent(q)}` : "");
    return req<PapersResponse>(`/api/papers?${qs}`);
  },

  getGraph: (source: PaperSource) => req<GraphResponse>(`/api/graph?${sourceQuery(source)}`),

  getCollections: () => req<Collection[]>("/api/collections"),
  createCollection: (name: string) =>
    req<Collection>("/api/collections", { method: "POST", body: JSON.stringify({ name }) }),
  renameCollection: (id: number, name: string) =>
    req<Collection>(`/api/collections/${id}`, { method: "PUT", body: JSON.stringify({ name }) }),
  deleteCollection: (id: number) => req<void>(`/api/collections/${id}`, { method: "DELETE" }),
  getCollectionFiles: (id: number) =>
    req<CollectionFilesResponse>(`/api/collections/${id}/files`),
  uploadFiles: (id: number, files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    return req<UploadResponse>(`/api/collections/${id}/files`, { method: "POST", body: form });
  },
  startImport: (id: number) =>
    req<ImportStartResponse>(`/api/collections/${id}/import`, { method: "POST" }),
  getImportStatus: (id: number) => req<ImportStatus>(`/api/collections/${id}/import/status`),
  fileContentUrl: (fileId: number) => `/api/collections/files/${fileId}/content`,
  setFilePmid: (fileId: number, pmid: string) =>
    req<CollectionFile>(`/api/collections/files/${fileId}/pmid`, {
      method: "POST",
      body: JSON.stringify({ pmid }),
    }),
  deleteCollectionFile: (fileId: number) =>
    req<void>(`/api/collections/files/${fileId}`, { method: "DELETE" }),
  refresh: (diseaseId?: number) => {
    const suffix = diseaseId ? `?disease=${diseaseId}` : "";
    return req<RefreshResponse>(`/api/refresh${suffix}`, { method: "POST" });
  },

  getSettings: () => req<AppSettings>("/api/settings"),
  updateSettings: (s: Partial<AppSettings> & { ncbi_api_key?: string }) =>
    req<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
};
