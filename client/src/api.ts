import type {
  AppSettings,
  AuthStatus,
  Collection,
  CollectionFile,
  CollectionFilesResponse,
  Topic,
  GraphResponse,
  ImportStartResponse,
  ImportStatus,
  Journal,
  JournalRemovalResult,
  JournalSearchResponse,
  JournalSuggestResponse,
  MeshSearchResponse,
  PaperSource,
  PapersResponse,
  RefreshResponse,
  ShareLinkResponse,
  TopicRemovalResult,
  UploadResponse,
} from "./types";

// The admin token unlocks mutating endpoints; GETs work without one. Kept in
// localStorage so an unlocked admin stays unlocked across reloads — the server
// re-verifies it on every request, so nothing is trusted from storage alone.
const TOKEN_KEY = "scibrarian_admin_token";

export function getAdminToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAdminToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// App registers a handler so a 401 mid-session (token rotated/revoked on the
// server) demotes the UI back to viewer mode.
let onAuthRejected: () => void = () => {};
export function setAuthRejectedHandler(fn: () => void): void {
  onAuthRejected = fn;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  // FormData bodies must set their own multipart boundary header.
  if (!(init?.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const token = getAdminToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    // The stored token is no longer valid; drop it and lock the UI. The error
    // thrown below still surfaces "Admin access required." to the caller.
    setAdminToken(null);
    onAuthRejected();
  }
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
  return "topic" in source ? `topic=${source.topic}` : `collection=${source.collection}`;
}

export const api = {
  getAuth: () => req<AuthStatus>("/api/auth"),

  getTopics: () => req<Topic[]>("/api/topics"),
  // Topics are MeSH headings: the server validates `name` against its indexed
  // descriptor list and builds the PubMed term itself.
  createTopic: (name: string) =>
    req<Topic>("/api/topics", { method: "POST", body: JSON.stringify({ name }) }),
  topicArticleCount: (id: number) => req<{ count: number }>(`/api/topics/${id}/article-count`),
  deleteTopic: (id: number) =>
    req<TopicRemovalResult>(`/api/topics/${id}`, { method: "DELETE" }),
  searchMesh: (q: string) =>
    req<MeshSearchResponse>(`/api/mesh/search?q=${encodeURIComponent(q)}`),

  getJournals: () => req<Journal[]>("/api/journals"),
  searchJournals: (q: string, limit?: number) =>
    req<JournalSearchResponse>(
      `/api/journals/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`
    ),
  // Per-topic journal suggestions for the Auto button; omitting perTopic uses
  // the server default (10 per topic).
  suggestJournals: (perTopic?: number) =>
    req<JournalSuggestResponse>(
      `/api/journals/suggest${perTopic ? `?per_topic=${perTopic}` : ""}`
    ),
  createJournal: (name: string, nlmId?: string) =>
    req<Journal>("/api/journals", {
      method: "POST",
      body: JSON.stringify(nlmId ? { name, nlmId } : { name }),
    }),
  journalArticleCount: (id: number) =>
    req<{ count: number }>(`/api/journals/${id}/article-count`),
  deleteJournal: (id: number) =>
    req<JournalRemovalResult>(`/api/journals/${id}`, { method: "DELETE" }),

  getPapers: (source: PaperSource, q?: string) => {
    const qs = sourceQuery(source) + (q ? `&q=${encodeURIComponent(q)}` : "");
    return req<PapersResponse>(`/api/papers?${qs}`);
  },

  // Abstracts are kept out of the papers list payload; the card fetches one lazily.
  getAbstract: (pmid: string) => req<{ abstract: string }>(`/api/articles/${pmid}/abstract`),

  // Takes the same `q` as getPapers, resolved server-side by the same SQL.
  getGraph: (source: PaperSource, q?: string) => {
    const qs = sourceQuery(source) + (q ? `&q=${encodeURIComponent(q)}` : "");
    return req<GraphResponse>(`/api/graph?${qs}`);
  },

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
  // Admin-only: mint an expiring signed URL for a stored PDF. Omitting
  // ttlSeconds uses the server's default share window (24h).
  mintShareLink: (fileId: number, ttlSeconds?: number) =>
    req<ShareLinkResponse>(`/api/collections/files/${fileId}/share`, {
      method: "POST",
      body: JSON.stringify(ttlSeconds != null ? { ttlSeconds } : {}),
    }),
  // Admin-only: mint an expiring signed URL that downloads the whole
  // collection as a zip.
  mintCollectionShareLink: (collectionId: number, ttlSeconds?: number) =>
    req<ShareLinkResponse>(`/api/collections/${collectionId}/share`, {
      method: "POST",
      body: JSON.stringify(ttlSeconds != null ? { ttlSeconds } : {}),
    }),
  setFilePmid: (fileId: number, pmid: string) =>
    req<CollectionFile>(`/api/collections/files/${fileId}/pmid`, {
      method: "POST",
      body: JSON.stringify({ pmid }),
    }),
  deleteCollectionFile: (fileId: number) =>
    req<void>(`/api/collections/files/${fileId}`, { method: "DELETE" }),
  refresh: (topicId?: number) => {
    const suffix = topicId ? `?topic=${topicId}` : "";
    return req<RefreshResponse>(`/api/refresh${suffix}`, { method: "POST" });
  },

  getSettings: () => req<AppSettings>("/api/settings"),
  updateSettings: (s: Partial<AppSettings> & { ncbi_api_key?: string }) =>
    req<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
};
