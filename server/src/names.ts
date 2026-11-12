import { MAX_NAME_CHARS } from "../../shared/limits.js";

// The two rules a name a person typed is held to — a collection's, a bookmark
// folder's, a topic's — each answering with what is wrong with it, or null.
// routes.ts sends them for the sections (badName, nameTaken) and
// topic-definition.ts throws them, so a name is refused in one wording
// wherever it is typed.

// Non-empty once trimmed, and no longer than the picker has room to draw. A 400.
//
// The cap is shared with the client, which sets it as the input's maxLength —
// this is the backstop for a request that didn't come from that box. `max` and
// `what` are a section entry's unless a caller has a cap of its own, as a topic
// does.
export function nameProblem(name: string, max = MAX_NAME_CHARS, what = "name"): string | null {
  if (!name) return "'name' is required.";
  if (name.length > max) return `A ${what} can be at most ${max} characters.`;
  return null;
}

// Names within a section are unique case-insensitively (see the unique index
// in db.ts) — two entries with the same name are indistinguishable in the
// picker. A 409 when the name belongs to a different row; `selfId` is the row
// being renamed, so re-saving an entry's own name (or just changing its case)
// isn't a conflict.
export function nameTakenBy(
  label: string,
  existing: { id: number; name: string } | undefined,
  selfId: number | null
): string | null {
  if (!existing || existing.id === selfId) return null;
  return `A ${label} named “${existing.name}” already exists.`;
}
