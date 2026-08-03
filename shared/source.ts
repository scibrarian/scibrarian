// Which paper set a view reads from, and how that travels over the wire.
//
// One definition for both sides. It used to be two: the client's PaperSource
// (`{collection: 3}`) and the server's PaperSourceQuery (`{collectionId: 3}`),
// with the predicates, the cache key and the query-string format hand-mirrored
// between them and a comment on each copy saying the two must agree. Adding
// "every collection at once" took eight coordinated edits held together by
// those comments, and one of them — a `"collectionId" in source` test standing
// in for "does this source have files" — was already silently wrong the moment
// a second file-bearing source existed.
//
// The spelling is the client's, because it is also the wire's: `?collection=3`.
export type PaperSource =
  | { topic: number }
  | { folder: number }
  | { collection: number }
  | { allCollections: true };

// Every function below names all four variants and ends here. The parameter is
// `never`, so it only accepts a value the branches above have fully narrowed
// away — adding a fifth source kind stops compiling in each place that has to
// decide something about it, which is the whole reason this file exists. The
// throw is for a caller reaching in from untyped code; typed callers can't.
function unhandledSource(source: never): never {
  throw new Error(`unknown paper source: ${JSON.stringify(source)}`);
}

// Does this source have uploaded files behind its papers? True for both
// collection kinds, false for topics and bookmark folders, which are lists of
// papers *seen* rather than held.
//
// Spelled out one variant at a time rather than as a single `in` test, because
// this is the predicate that was already wrong once: it decides what the UI
// promises a search covers *and* what the query actually covers, and a new
// source that quietly defaulted to "no files" dropped the papers view's file
// columns, its body-text clause and its excerpts at a stroke, failing nothing.
// A new source has to answer this question rather than inherit an answer.
export function sourceHasFiles(source?: PaperSource): boolean {
  if (!source) return false;
  if ("topic" in source) return false;
  if ("folder" in source) return false;
  if ("collection" in source) return true;
  if ("allCollections" in source) return true;
  return unhandledSource(source);
}

// Stable cache/state key ("t3" / "f2" / "c1" / "c*"). No collection id can
// collide with the every-collection key.
export function sourceKey(source: PaperSource): string {
  if ("topic" in source) return `t${source.topic}`;
  if ("folder" in source) return `f${source.folder}`;
  if ("collection" in source) return `c${source.collection}`;
  if ("allCollections" in source) return "c*";
  return unhandledSource(source);
}

// The query param both source-driven endpoints use. `?collection=all` is spelled
// as a value of the existing param rather than a fourth one, so the choice stays
// a three-way choice.
export function encodeSource(source: PaperSource): string {
  if ("topic" in source) return `topic=${source.topic}`;
  if ("folder" in source) return `folder=${source.folder}`;
  if ("collection" in source) return `collection=${source.collection}`;
  if ("allCollections" in source) return "collection=all";
  return unhandledSource(source);
}

// The inverse, for the server. Takes a plain query bag rather than a request so
// this file stays free of Express. null = nothing usable was given, which the
// routes turn into a 400.
//
// The one direction with no exhaustiveness check, because there is no union on
// the way in to exhaust — a new source added to encodeSource and not to this
// makes the client send a param the server can't read. That surfaces as a 400
// on the endpoint rather than as wrong data, which is loud enough; the pair
// living in one file is what makes it hard to miss in the first place.
//
// The first source given wins when several are sent. Ids are read with Number(),
// so 0 and NaN both fall through — `?topic=` with no value, or a non-numeric
// one, is "not given" rather than an id of zero.
export function decodeSource(query: Record<string, unknown>): PaperSource | null {
  const topic = Number(query.topic);
  if (topic) return { topic };
  const folder = Number(query.folder);
  if (folder) return { folder };
  if (query.collection === "all") return { allCollections: true };
  const collection = Number(query.collection);
  if (collection) return { collection };
  return null;
}
