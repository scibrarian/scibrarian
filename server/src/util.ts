// Small helpers shared across server modules.

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function round1(n: number | null): number | null {
  return n == null ? null : Math.round(n * 10) / 10;
}
