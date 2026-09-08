// What both halves of the database code have to agree on.
//
// Separate from limits.ts, which is scoped to request limits the *client* also
// checks. Nothing here is the browser's business; the two importers are the
// server and the Pro module, which query the same database through separate
// packages and would otherwise each carry their own copy of this number.

/**
 * How many ids one `IN (...)` query is given at a time.
 *
 * Not derived from the ceiling, and deliberately nowhere near it: the bundled
 * SQLite (3.53.1 as of writing) accepts 32766 bound parameters, measured rather
 * than assumed, so this leaves about thirty-six times the room it needs. The
 * value is conservative on purpose and there is no evidence the size costs
 * anything — an all-time search hands these queries thousands of PMIDs, which
 * is a handful of chunks either way.
 *
 * Kept low rather than raised to the ceiling because the callers do not all
 * pass ids alone: queryByIds appends its `extra` params after the chunk, so the
 * chunk must never be the whole budget. A number chosen to just fit would have
 * to be revisited by anyone adding a parameter to a query, and would fail at
 * the boundary — on the one request large enough to reach it.
 */
export const SQL_PARAMS_PER_CHUNK = 900;

/**
 * Chunk a list of ids, handing each chunk to `fn` as a placeholder list and the
 * params to bind against it: the chunk's ids, then `extra`.
 *
 * Ids rather than PMIDs, because holdingsByDois runs the same query shape over
 * DOIs. Nothing here reads the values — they are bound, never interpolated — so
 * the only thing the name was ever describing was the caller.
 *
 * Here rather than in db.ts because the size above and this bind order are one
 * rule, and a caller needs both halves of it. A statement written against the
 * opposite order returns nothing rather than failing, so a second copy to keep
 * in step is a second place for that to happen silently — which is what the
 * cross-workspace holdings union had become before this moved.
 *
 * Pure: it captures no database handle, which is what lets a module holding a
 * different workspace's connection use it unchanged.
 */
export function eachIdChunk(
  ids: string[],
  extra: (string | number)[],
  fn: (placeholders: string, params: (string | number)[]) => void
): void {
  for (let i = 0; i < ids.length; i += SQL_PARAMS_PER_CHUNK) {
    const batch = ids.slice(i, i + SQL_PARAMS_PER_CHUNK);
    fn(batch.map(() => "?").join(","), [...batch, ...extra]);
  }
}
