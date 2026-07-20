import { useState } from "react";
import { api } from "../api";
import { errorMessage } from "./format";
import type { AuthStatus } from "../types";

// What a title click needs to know about a paper: where PubMed is, and which
// stored PDF (if any) should take precedence over it. Both Paper and GraphNode
// satisfy this, so every view opens papers the same way.
export interface OpenablePaper {
  url: string;
  file_id: number | null;
  file_name: string | null;
  file_exists: boolean;
}

// The app-wide access snapshot a click is judged against, plus the callback
// that folds a freshly-fetched one back into app state.
export interface PaperAccess {
  isAdmin: boolean;
  tokenRequired: boolean;
  libraryOpen: boolean;
  // Reports the fresh /auth fetched on a click so the app-wide snapshot
  // (isAdmin/tokenRequired/libraryOpen) heals without a reload.
  onAuthRefreshed: (auth: AuthStatus) => void;
}

export interface PaperOpener {
  openPaper: (p: OpenablePaper) => void;
  opensStoredPdf: (p: OpenablePaper) => boolean;
  openError: string | null;
  clearOpenError: () => void;
}

// Opening a paper is identical in every view (table, timeline, graph): a stored
// PDF when one exists and the viewer may have it, PubMed otherwise. Papers from
// a topic have no file, so the same handler does the right thing there too —
// no branching on which workspace we're in.
export function usePaperOpener({
  isAdmin,
  tokenRequired,
  libraryOpen,
  onAuthRefreshed,
}: PaperAccess): PaperOpener {
  const [openError, setOpenError] = useState<string | null>(null);

  // Predicts what a click will open, for hover tooltips and the file badge
  // only. It reads the auth snapshot, which can lag a mid-session Open Library
  // toggle until the next click refreshes it — openPaper decides against a
  // fresh /auth.
  function opensStoredPdf(p: OpenablePaper): boolean {
    if (p.file_id == null || !p.file_exists) return false;
    if (!tokenRequired || libraryOpen) return true; // bare URL works for everyone
    return isAdmin;
  }

  // Open what a click refers to. When a stored PDF exists, the access policy
  // (open library / token mode / admin) is re-checked against a fresh /auth at
  // click time — the load-time snapshot goes stale when the owner toggles Open
  // Library mid-session, which used to strand viewers on a raw 401 tab (closed
  // after load) or hide newly opened PDFs (opened after load).
  async function openPaper(p: OpenablePaper) {
    // No matched file, or the blob is gone (orphaned/deleted) — plain PubMed
    // link rather than a content URL the server answers with 410.
    if (p.file_id == null || !p.file_exists) {
      return void window.open(p.url, "_blank", "noopener");
    }
    const fileId = p.file_id;
    // The tab must be opened synchronously in the click (popup blockers); it
    // is navigated once the fresh policy is known. Detach opener since the
    // fallback destination (PubMed) is cross-origin.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const auth = await api.getAuth();
      onAuthRefreshed(auth); // heal the app-wide snapshot too
      let url: string;
      if (!auth.token_required || auth.library_open) {
        url = api.fileContentUrl(fileId); // bare URL works for everyone
      } else if (auth.admin) {
        // window.open can't carry the Authorization header, so mint a
        // short-lived signed URL first.
        const { path } = await api.mintShareLink(fileId, 300);
        url = new URL(path, window.location.origin).toString();
      } else {
        url = p.url; // PDFs are owner-only and we're a viewer: go to PubMed
      }
      if (tab) tab.location.href = url;
      else window.open(url, "_blank", "noopener");
    } catch (err) {
      tab?.close();
      setOpenError(errorMessage(err));
    }
  }

  return {
    openPaper: (p) => void openPaper(p),
    opensStoredPdf,
    openError,
    clearOpenError: () => setOpenError(null),
  };
}

// The hover tooltip for a clickable title, shared so all three views describe
// the same click the same way.
export function openTitle(p: OpenablePaper, opensStoredPdf: (p: OpenablePaper) => boolean): string {
  return opensStoredPdf(p) ? `Open ${p.file_name}` : "Open on PubMed";
}
