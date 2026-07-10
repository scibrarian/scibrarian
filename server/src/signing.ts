import crypto from "node:crypto";
import { ADMIN_TOKEN } from "./config.js";

// Stateless expiring share links for stored PDFs, S3-presigned-URL style:
// sig = HMAC-SHA256(`${fileId}:${contentHash}:${exp}`) carried in the URL as
// `?exp=<unix-secs>&sig=<hex>`. The content hash is bound into the MAC (but
// never appears in the URL) so a link can only ever serve the exact bytes
// that were shared — collection_files ids are SQLite rowids, which can be
// reused after a delete.

// Without an ADMIN_TOKEN everyone is admin and the key below would derive
// from "", so links are refused rather than minted meaninglessly.
export const signingEnabled = ADMIN_TOKEN.length > 0;

// Domain-separated from the raw token; rotating ADMIN_TOKEN revokes every
// outstanding link (intentional — it's the owner's kill switch).
const SHARE_KEY = crypto.createHash("sha256").update(`sciluminate-share:${ADMIN_TOKEN}`).digest();

function mac(payload: string, exp: number): string {
  return crypto.createHmac("sha256", SHARE_KEY).update(`${payload}:${exp}`).digest("hex");
}

function sign(payload: string, ttlSeconds: number): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { exp, sig: mac(payload, exp) };
}

export type ShareVerdict = "ok" | "invalid" | "expired";

// req.query values are untrusted and can be arrays (`?exp=a&exp=b`).
function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function verify(payload: string, expRaw: unknown, sigRaw: unknown): ShareVerdict {
  const expStr = asString(expRaw);
  const sig = asString(sigRaw);
  if (!expStr || !sig || !/^\d{1,12}$/.test(expStr)) return "invalid";
  const exp = Number(expStr);
  // Hash both sides so timingSafeEqual never throws on length mismatch — the
  // same idiom as the admin tokenMatches check.
  const a = crypto.createHash("sha256").update(sig).digest();
  const b = crypto.createHash("sha256").update(mac(payload, exp)).digest();
  if (!crypto.timingSafeEqual(a, b)) return "invalid";
  return exp * 1000 < Date.now() ? "expired" : "ok";
}

// A file MAC can never collide with a collection MAC: file payloads start
// with a digit, collection payloads with "collection:".
function filePayload(fileId: number, contentHash: string): string {
  return `${fileId}:${contentHash}`;
}

// Collection ids are AUTOINCREMENT (never reused), so unlike files there is
// no stale-id hazard to bind against. The grant is deliberately "the
// collection as it exists at download time" — files added while the link
// lives are included.
function collectionPayload(collectionId: number): string {
  return `collection:${collectionId}`;
}

export function signFileShare(
  fileId: number,
  contentHash: string,
  ttlSeconds: number
): { exp: number; sig: string } {
  return sign(filePayload(fileId, contentHash), ttlSeconds);
}

export function verifyFileShare(
  fileId: number,
  contentHash: string,
  expRaw: unknown,
  sigRaw: unknown
): ShareVerdict {
  return verify(filePayload(fileId, contentHash), expRaw, sigRaw);
}

export function signCollectionShare(
  collectionId: number,
  ttlSeconds: number
): { exp: number; sig: string } {
  return sign(collectionPayload(collectionId), ttlSeconds);
}

export function verifyCollectionShare(
  collectionId: number,
  expRaw: unknown,
  sigRaw: unknown
): ShareVerdict {
  return verify(collectionPayload(collectionId), expRaw, sigRaw);
}
