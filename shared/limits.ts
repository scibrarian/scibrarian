// Upload limits both sides must agree on. The server is the one that enforces
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
