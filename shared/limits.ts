// Request limits both sides must agree on. The server is the one that enforces
// them; the client checks first only so it can report a rejection usefully,
// before spending the bytes.

// Largest single PDF an upload request will accept.
//
// Multer rejects the *entire* request when one file exceeds this, so a single
// oversized scan would take its whole batch down with it — and its "File too
// large" doesn't say which file was at fault, which is useless when the user
// picked a folder of hundreds. The client filters oversized files out by name
// before batching; this is the backstop.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Most files one upload request may carry. The client batches well below this;
// it exists so a hand-rolled request can't hand multer an unbounded multipart
// body.
export const MAX_UPLOAD_FILES = 50;

// Most papers one bulk bookmark save may carry.
//
// The whole filtered set goes in a single request on purpose: the save is one
// transaction and one set of added/already-saved counts, and the queries under
// it already chunk their bound parameters, so splitting it into batches would
// trade both away for a limit the database doesn't have. This bounds the
// request instead — well past any plausible filtered set, since the button's
// whole point is sets too large to eyeball.
export const MAX_BULK_BOOKMARK_PMIDS = 50_000;

// References one "do I already have this?" request may carry.
//
// The check is a GET (see the /have route), so the batch is bounded by what
// belongs in a URL rather than by anything in the database. The client splits a
// larger paste across several requests; the server reports whatever one request
// had to drop, so a hand-written URL gets a count rather than silence.
export const MAX_REFS_PER_HAVE_REQUEST = 50;

// Most references one paste is checked in total, across those batches. A
// manuscript's reference list is tens, not thousands; this stops a stray paste
// of a whole document from becoming a hundred round-trips.
export const MAX_HAVE_REFS = 300;

// The body size that many PMIDs needs. An 8-digit id serializes to
// `"12345678",` — 11 bytes — so this is doubled headroom for longer ids and
// the JSON around them. Derived rather than written out separately: a cap
// raised without the parser limit following it would fail every large save at
// body-parser, which reports payload-too-large and nothing about why.
export const MAX_BULK_BOOKMARK_BYTES = MAX_BULK_BOOKMARK_PMIDS * 22;
