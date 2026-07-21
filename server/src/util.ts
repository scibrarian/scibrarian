// Small helpers shared across server modules.

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The body sent for any server-side (5xx) error whose message wasn't marked
// safe to expose. The real cause is logged, never returned — internal detail
// (fs paths, upstream/library strings, stack messages) must not leak to clients.
export const GENERIC_SERVER_ERROR = "Something went wrong on the server. Please try again.";

// An Error whose message we authored and vetted, so it's safe to show a client.
// `expose` is the marker every client-facing layer checks — the error middleware
// (index.ts), poll results, and import jobs all report the raw message only when
// it's set, and the generic body otherwise. Mirrors the flag http-errors uses,
// without taking the dependency.
export function safeError(message: string): Error & { expose: true } {
  return Object.assign(new Error(message), { expose: true as const });
}

// A safeError that also carries an HTTP status, for throwing straight out of a
// route into the error middleware.
export function httpError(status: number, message: string): Error & { status: number; expose: true } {
  return Object.assign(safeError(message), { status });
}

// What to report to a client about `err`: its real message when it was marked
// exposable, the generic body otherwise. For the failures that aren't HTTP
// responses — a per-topic poll error, a failed import job — where the raw
// message would otherwise reach the UI verbatim. Callers log the real cause
// first; this is only what the client sees.
export function safeMessage(err: unknown): string {
  return (err as { expose?: unknown } | null)?.expose === true
    ? errMessage(err)
    : GENERIC_SERVER_ERROR;
}

export function round1(n: number | null): number | null {
  return n == null ? null : Math.round(n * 10) / 10;
}
