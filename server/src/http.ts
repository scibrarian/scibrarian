// Node's built-in fetch (undici) only enforces *inactivity* timeouts — its
// ~5-minute headers/body limits reset on every byte received — so a peer that
// stalls right after the headers, or trickles the body a byte at a time, can
// hold a request open for minutes or indefinitely. /papers and /graph await the
// iCite warm-up before responding, so such a stall becomes user-visible latency.
// Wrapping fetch in AbortSignal.timeout turns an open-ended hang into a bounded,
// catchable TimeoutError, which every caller here already handles as best-effort.

// Small JSON/XML/HEAD requests (iCite, OpenAlex, eutils, the MeSH probes) resolve
// in well under a second when healthy; 30s is a generous ceiling that only trips
// on a genuine stall, not on ordinary slowness.
export const API_TIMEOUT_MS = 30_000;

// The bulk reference-data downloads (NLM J_Medline ~10 MB, MeSH descriptors
// ~30–40 MB streamed) legitimately take longer, so they get a looser cap that
// still bounds an infinite hang. Both are background, best-effort refreshes.
export const DOWNLOAD_TIMEOUT_MS = 300_000;

// fetch with a hard overall time budget. Takes one options bag — RequestInit
// plus `timeoutMs` — so the two callers that only want a longer budget can name
// it instead of passing an empty init to reach a third positional argument.
//
// `signal` is deliberately not accepted: this function owns the signal, and a
// caller-supplied one would have to be merged rather than overwritten. Nothing
// needs that today, so it's a compile error rather than a silent override —
// reinstate AbortSignal.any() here if a caller ever does.
export function fetchWithTimeout(
  url: string | URL,
  { timeoutMs = API_TIMEOUT_MS, ...init }: Omit<RequestInit, "signal"> & { timeoutMs?: number } = {}
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
