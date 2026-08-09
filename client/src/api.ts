import type {
  AbstractsResponse,
  AppSettings,
  AuthStatus,
  BookmarkEntry,
  BookmarkFolder,
  Collection,
  CollectionFile,
  CollectionFilesResponse,
  Topic,
  GraphResponse,
  HaveAnswer,
  HaveResponse,
  ImportStartResponse,
  ImportStatus,
  Journal,
  JournalRemovalResult,
  JournalSearchResponse,
  JournalSuggestResponse,
  MeshHeadingsResponse,
  MeshSearchResponse,
  PaperQuery,
  PaperSource,
  PapersResponse,
  ProLicense,
  ProMasterStatus,
  ProNodesResponse,
  ProPairingMinted,
  ProPullResult,
  RefreshResponse,
  ShareLinkResponse,
  TopicRemovalResult,
  TopicSuggestResponse,
  UploadResponse,
} from "./types";
import { MAX_HAVE_REFS, MAX_REFS_PER_HAVE_REQUEST } from "../../shared/limits";
import { encodeSource } from "../../shared/source";

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

// The query param naming both source-driven endpoints share. Defined in
// shared/source.ts beside the server's decodeSource, so the two halves of the
// format are written once and read together.
const sourceQuery = encodeSource;

// The server-side filters, appended to a source query. One builder for /papers
// and /graph so a filter can't reach one endpoint and be dropped by the other.
// mesh_major is only sent alongside a selection, since on its own it narrows
// nothing and would just split the cache.
function filterQuery(filter?: PaperQuery): string {
  if (!filter) return "";
  let qs = "";
  if (filter.q) qs += `&q=${encodeURIComponent(filter.q)}`;
  if (filter.mesh && filter.mesh.length > 0) {
    qs += `&mesh=${filter.mesh.map(encodeURIComponent).join(",")}`;
    if (filter.meshMajor) qs += "&mesh_major=1";
  }
  return qs;
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
  // The subjects one source is filed under (the toolbar facet), not the whole
  // MeSH vocabulary — `q` searches within them.
  getMeshHeadings: (source: PaperSource, q?: string) =>
    req<MeshHeadingsResponse>(
      `/api/mesh/headings?${sourceQuery(source)}${q ? `&q=${encodeURIComponent(q)}` : ""}`
    ),
  // Topics the user's own held papers suggest, for the Settings picker.
  suggestTopics: () => req<TopicSuggestResponse>("/api/topics/suggest"),

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

  getPapers: (source: PaperSource, filter?: PaperQuery) =>
    req<PapersResponse>(`/api/papers?${sourceQuery(source)}${filterQuery(filter)}`),

  // "Do I already have this?" — one answer per pasted line, in the order given.
  //
  // Batched here rather than in the caller: the endpoint is a GET, so a long
  // paste doesn't fit in one URL, and the alternative (make the component split
  // its own list and stitch the answers back into order) puts the ordering
  // guarantee in the UI where it's easy to break. Batches run in sequence, not
  // in parallel — the enrichment step calls OpenAlex, and firing six of those at
  // once at a free service to save a second is not a trade worth making.
  // `allowNetwork: false` sends ?free=0, which means "answer without leaving
  // the machine". It suppresses the org check as well as the free-copy lookup —
  // the flag is about network calls, not about free copies — so a caller that
  // passes false gets the local held/not-held verdict and nothing else. It was
  // named lookUpFree, which read as if only OpenAlex were at stake, and the
  // post-pull refresh below turned that misreading into a wrong answer.
  checkHave: async (refs: string[], allowNetwork = true): Promise<HaveResponse> => {
    const capped = refs.slice(0, MAX_HAVE_REFS);
    const results: HaveAnswer[] = [];
    let truncated = refs.length - capped.length;
    for (let i = 0; i < capped.length; i += MAX_REFS_PER_HAVE_REQUEST) {
      const batch = capped.slice(i, i + MAX_REFS_PER_HAVE_REQUEST);
      const res = await req<HaveResponse>(
        `/api/have?q=${encodeURIComponent(batch.join("\n"))}${allowNetwork ? "" : "&free=0"}`
      );
      results.push(...res.results);
      truncated += res.truncated;
    }
    return { results, truncated };
  },

  // Abstracts are kept out of the papers list payload; the timeline fetches
  // them lazily, one rendered chunk per request rather than one per card.
  getAbstracts: (pmids: string[]) =>
    req<AbstractsResponse>(`/api/abstracts?pmids=${pmids.join(",")}`),

  // Takes the same filters as getPapers, resolved server-side by the same SQL.
  getGraph: (source: PaperSource, filter?: PaperQuery) =>
    req<GraphResponse>(`/api/graph?${sourceQuery(source)}${filterQuery(filter)}`),

  getBookmarkFolders: () => req<BookmarkFolder[]>("/api/bookmark-folders"),
  createBookmarkFolder: (name: string) =>
    req<BookmarkFolder>("/api/bookmark-folders", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  renameBookmarkFolder: (id: number, name: string) =>
    req<BookmarkFolder>(`/api/bookmark-folders/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  deleteBookmarkFolder: (id: number) =>
    req<void>(`/api/bookmark-folders/${id}`, { method: "DELETE" }),
  getBookmarks: () => req<BookmarkEntry[]>("/api/bookmarks"),
  // One call for both the single-paper toggle and the bulk save — the bulk case
  // is just a longer list. `alreadySaved` is what lets the bulk result say how
  // many papers actually landed rather than overclaiming.
  addBookmarks: (folderId: number, pmids: string[]) =>
    req<{ added: number; alreadySaved: number; missing: number }>(
      `/api/bookmark-folders/${folderId}/papers`,
      { method: "POST", body: JSON.stringify({ pmids }) }
    ),
  removeBookmark: (folderId: number, pmid: string) =>
    req<void>(`/api/bookmark-folders/${folderId}/papers/${pmid}`, { method: "DELETE" }),

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

  // ---------- Pro: shared holdings ----------
  //
  // Every one of these 404s in a free build, where /api/pro is unmounted. The
  // UI never reaches them: it renders off `auth.pro`, which is null there.

  proNodes: () => req<ProNodesResponse>("/api/pro/nodes"),
  proMintNode: (name: string, masterUrl: string, ttlDays?: number) =>
    req<ProPairingMinted>("/api/pro/nodes", {
      method: "POST",
      body: JSON.stringify({ name, master_url: masterUrl, ttl_days: ttlDays }),
    }),
  proRevokeNode: (id: number) =>
    req<{ revoked: boolean }>(`/api/pro/nodes/${id}`, { method: "DELETE" }),
  // An empty string clears it. There is no getter: the licence is reported
  // through proNodes(), which never returns the key itself.
  proSetLicense: (licenseKey: string) =>
    req<{ license: ProLicense }>("/api/pro/license", {
      method: "PUT",
      body: JSON.stringify({ license_key: licenseKey }),
    }),

  proSetOrgName: (orgName: string) =>
    req<{ org_name: string }>("/api/pro/org-name", {
      method: "PUT",
      body: JSON.stringify({ org_name: orgName }),
    }),

  proMaster: () => req<ProMasterStatus>("/api/pro/master"),
  proConnect: (code: string) =>
    req<{ connected: boolean; name: string }>("/api/pro/master", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  proDisconnect: () => req<ProMasterStatus>("/api/pro/master", { method: "DELETE" }),

  // The PMID goes in the body rather than the path on purpose — see the route.
  proPull: (pmid: string) =>
    req<ProPullResult>("/api/pro/holdings/pull", {
      method: "POST",
      body: JSON.stringify({ pmid }),
    }),
};
