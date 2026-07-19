import { describe, it, expect } from "vitest";

// config.ts reads ADMIN_TOKEN at import time, so the env var must be set
// before signing.ts is evaluated — hence the dynamic import. dotenv never
// overwrites an already-set variable, so a real .env can't interfere.
process.env.ADMIN_TOKEN = "test-admin-token";
const {
  signingEnabled,
  signFileShare,
  verifyFileShare,
  signCollectionShare,
  verifyCollectionShare,
} = await import("./signing.js");

// Corrupt a hex signature while keeping it well-formed.
function corrupt(sig: string): string {
  return (sig[0] === "0" ? "1" : "0") + sig.slice(1);
}

const HASH = "abc123def456";

describe("signingEnabled", () => {
  it("is enabled when ADMIN_TOKEN is set", () => {
    expect(signingEnabled).toBe(true);
  });
});

describe("file share links", () => {
  it("verifies a freshly signed link", () => {
    const { exp, sig } = signFileShare(7, HASH, 3600);
    expect(verifyFileShare(7, HASH, String(exp), sig)).toBe("ok");
  });

  it("rejects an expired link as expired, not invalid", () => {
    const { exp, sig } = signFileShare(7, HASH, -60);
    expect(verifyFileShare(7, HASH, String(exp), sig)).toBe("expired");
  });

  it("rejects a tampered signature", () => {
    const { exp, sig } = signFileShare(7, HASH, 3600);
    expect(verifyFileShare(7, HASH, String(exp), corrupt(sig))).toBe("invalid");
  });

  it("rejects a tampered expiry (exp is bound into the MAC)", () => {
    const { exp, sig } = signFileShare(7, HASH, 3600);
    expect(verifyFileShare(7, HASH, String(exp + 1), sig)).toBe("invalid");
  });

  it("rejects the right signature for the wrong file id", () => {
    const { exp, sig } = signFileShare(7, HASH, 3600);
    expect(verifyFileShare(8, HASH, String(exp), sig)).toBe("invalid");
  });

  it("rejects a reused id whose content hash changed", () => {
    const { exp, sig } = signFileShare(7, HASH, 3600);
    expect(verifyFileShare(7, "other-hash", String(exp), sig)).toBe("invalid");
  });
});

describe("collection share links", () => {
  it("verifies a freshly signed link", () => {
    const { exp, sig } = signCollectionShare(3, 3600);
    expect(verifyCollectionShare(3, String(exp), sig)).toBe("ok");
  });

  it("rejects the signature of a different collection", () => {
    const { exp, sig } = signCollectionShare(3, 3600);
    expect(verifyCollectionShare(4, String(exp), sig)).toBe("invalid");
  });
});

describe("untrusted query values", () => {
  it("rejects array-valued exp and sig (?exp=a&exp=b)", () => {
    const { exp, sig } = signFileShare(7, HASH, 3600);
    expect(verifyFileShare(7, HASH, [String(exp)], sig)).toBe("invalid");
    expect(verifyFileShare(7, HASH, String(exp), [sig])).toBe("invalid");
  });

  it("rejects missing or non-numeric exp", () => {
    const { sig } = signFileShare(7, HASH, 3600);
    expect(verifyFileShare(7, HASH, undefined, sig)).toBe("invalid");
    expect(verifyFileShare(7, HASH, "soon", sig)).toBe("invalid");
    expect(verifyFileShare(7, HASH, "", sig)).toBe("invalid");
  });

  it("rejects an exp longer than 12 digits", () => {
    const { sig } = signFileShare(7, HASH, 3600);
    expect(verifyFileShare(7, HASH, "1".repeat(13), sig)).toBe("invalid");
  });

  it("rejects a missing or malformed signature without throwing", () => {
    const { exp } = signFileShare(7, HASH, 3600);
    expect(verifyFileShare(7, HASH, String(exp), undefined)).toBe("invalid");
    expect(verifyFileShare(7, HASH, String(exp), "not-hex")).toBe("invalid");
  });
});
