// Small formatting helpers shared across components.

// "A, B, C, et al." once the list exceeds `max` names.
export function formatAuthors(authors: string[], max: number): string {
  if (authors.length === 0) return "—";
  if (authors.length <= max) return authors.join(", ");
  return authors.slice(0, max).join(", ") + ", et al.";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
