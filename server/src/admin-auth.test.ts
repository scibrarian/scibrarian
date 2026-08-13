import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb } from "./test-db.js";

// Which credentials open the admin gate.
//
// The header the browser sends is the reason this file exists. api.ts puts the
// admin token in X-Admin-Token, and until now nothing in the suite sent that
// header — every test that authenticated used Bearer, so the entire path the
// shipped client takes for every mutation was unexercised. A rename, a dropped
// .trim(), or a reorder of the two branches would have left the suite green
// while every admin write from the UI 401'd in production, which is the class
// of failure the header change was made to repair.
//
// Asserted over HTTP rather than against isAdminRequest directly: what matters
// is the status an actual request gets back, and the gate is middleware whose
// position in the stack is part of the behaviour.

// config.ts reads ADMIN_TOKEN at import time, and with no token every request
// is the owner (single-user mode) — which would make every assertion below
// silently vacuous. Set before any dynamic import, as signing.test.ts does;
// dotenv never overwrites an already-set variable.
process.env.ADMIN_TOKEN = "test-admin-token";
const TOKEN = "test-admin-token";

// A plausible edge login. Behind basic auth the browser sends this on every
// request, including the ones carrying the admin token.
const BASIC = `Basic ${Buffer.from("admin:sitepassword").toString("base64")}`;

let server: Server;
let base: string;

beforeAll(async () => {
  await openTempDb("admin-auth");
  const { api } = await import("./routes.js");
  const app = express();
  app.use("/api", api);
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  closeTempDb();
});

// A POST to a path no route claims. The gate is registered before every route,
// so it answers first: REFUSED is the gate turning the request away, ADMITTED
// is the gate passing it to a router with nothing to match. Asking about the
// gate alone keeps these independent of any real route's validation, its
// database state and its side effects — and an admitted request that went on to
// actually mutate something would be the worse thing to leave behind.
const REFUSED = 401;
const ADMITTED = 404;

async function post(headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(`${base}/api/no-such-route`, { method: "POST", headers });
  return res.status;
}

describe("the admin gate", () => {
  it("refuses a request with no credential at all", async () => {
    expect(await post()).toBe(REFUSED);
  });

  it("refuses a wrong X-Admin-Token", async () => {
    expect(await post({ "x-admin-token": "wrong" })).toBe(REFUSED);
  });

  it("accepts X-Admin-Token, which is what the browser client sends", async () => {
    expect(await post({ "x-admin-token": TOKEN })).toBe(ADMITTED);
  });

  it("accepts Bearer, which is what the setup scripts and curl send", async () => {
    expect(await post({ authorization: `Bearer ${TOKEN}` })).toBe(ADMITTED);
  });

  // Both headers are read rather than the first one found deciding. A stale
  // token in localStorage, or one inserted by a proxy or an extension, used to
  // shadow a valid Bearer — so a request refused for the credential it carried
  // beside the right one.
  it("accepts a valid Bearer even with a stale X-Admin-Token beside it", async () => {
    expect(await post({ "x-admin-token": "stale", authorization: `Bearer ${TOKEN}` })).toBe(
      ADMITTED
    );
  });

  it("accepts a valid X-Admin-Token even with a wrong Bearer beside it", async () => {
    expect(await post({ "x-admin-token": TOKEN, authorization: "Bearer wrong" })).toBe(ADMITTED);
  });

  it("falls through to Bearer when X-Admin-Token is present but empty", async () => {
    expect(await post({ "x-admin-token": "", authorization: `Bearer ${TOKEN}` })).toBe(ADMITTED);
  });

  // The site login is not owner access. Getting past the edge means you may
  // reach the app, not that you may write to it.
  it("does not mistake an edge basic-auth login for the admin token", async () => {
    expect(await post({ authorization: BASIC })).toBe(REFUSED);
  });

  // The case the header change was made for: a browser behind an edge login,
  // whose Authorization is already spoken for.
  it("accepts X-Admin-Token travelling beside a Basic Authorization", async () => {
    expect(await post({ authorization: BASIC, "x-admin-token": TOKEN })).toBe(ADMITTED);
  });
});

// api.ts tells our 401 from an edge's by the absence of this header, and drops
// the stored admin token only for ours — otherwise a re-provisioned site
// password, which makes Caddy challenge an already-open tab, would read as "the
// admin token was rejected" and silently discard a good one. RFC 9110 requires
// WWW-Authenticate on a 401 from something that authenticates, so the two are
// distinguishable; this pins the half of that contract the server owns.
describe("the 401 the gate sends", () => {
  it("carries no WWW-Authenticate, and says why in JSON", async () => {
    const res = await fetch(`${base}/api/no-such-route`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    expect(await res.json()).toEqual({ error: "Admin access required." });
  });
});
