// The one fact about a 401 that both ends have to agree on.

/**
 * Sent in the body of a 401 raised by *our* admin gate, and by nothing else.
 *
 * The client drops the stored admin token when it sees this and leaves it alone
 * when it doesn't. Both halves matter. A re-provisioned site rotates the basic
 * auth password, which makes the edge challenge an already-open tab; reading
 * that challenge as a verdict on the admin token discarded a perfectly good one
 * for a reason that had nothing to do with it, and the owner's only way back was
 * to clear localStorage by hand.
 *
 * A field we send rather than a property we infer. The absence of
 * WWW-Authenticate stood in for this before, and absence is the default state of
 * everything: an edge that attaches the header to responses it forwards, or an
 * error handler that rewrites a 401 body, changes the answer without any of it
 * being about us — and `headers.get()` returns "" for a present-but-empty
 * header, which reads as absent too. Exactly one thing produces this string.
 *
 * Both admin gates send it: the one in server/src/routes.ts and Pro's
 * requireAdmin, which sits outside that gate but answers the same question. A
 * spoke's "Not a paired node." 401 deliberately does not — that refusal is about
 * a pairing token, and the owner's admin token is not what it rejected.
 */
export const ADMIN_TOKEN_REJECTED = "admin_token_rejected";
