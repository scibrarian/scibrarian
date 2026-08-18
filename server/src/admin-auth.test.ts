import type { Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTempDb, openTempDb } from "./test-db.js";
import { ADMIN_TOKEN_REJECTED } from "../../shared/auth.js";

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

/**
 * The same POST, with the header lines written out literally.
 *
 * fetch cannot send two headers of one name — Headers folds a repeated name
 * into a single comma-joined value before anything reaches the wire — and what
 * the gate has to survive is Node performing that same fold on the receiving
 * side. Sending it as two lines is the only way to assert against the thing
 * that actually happens rather than against a hand-built imitation of it.
 */
function postRaw(headerLines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        [
          "POST /api/no-such-route HTTP/1.1",
          "Host: 127.0.0.1",
          ...headerLines,
          "Content-Length: 0",
          "Connection: close",
          "",
          "",
        ].join("\r\n")
      );
    });
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => (buf += d));
    sock.on("error", reject);
    sock.on("end", () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) resolve(Number(m[1]));
      else reject(new Error(`no status line in: ${buf.slice(0, 200)}`));
    });
  });
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

// Two of our own header, which is not the same failure as a stale one. Node
// welds repeated headers into "ours, theirs" instead of letting the first win,
// so the gate never saw either value — and the request that hits this is the
// one with no Bearer to fall back to, because the edge owns Authorization.
// Refusing it 401s every mutation, and api.ts reads that as the token being
// rejected and drops a perfectly good one.
describe("a duplicated X-Admin-Token", () => {
  const dup = (a: string, b: string) => postRaw([`X-Admin-Token: ${a}`, `X-Admin-Token: ${b}`]);

  it("is joined by Node rather than de-duplicated, which is the whole problem", async () => {
    // Pins the premise the fix rests on. If Node ever kept the first value
    // instead, the joined-value handling below would be dead code and this
    // would say so rather than leaving it to be inferred.
    const seen = await new Promise<string | undefined>((resolve) => {
      const probe = express();
      probe.post("*", (req, res) => {
        resolve(req.get("x-admin-token"));
        res.end();
      });
      const s = probe.listen(0, () => {
        const { port } = s.address() as AddressInfo;
        void fetch(`http://127.0.0.1:${port}/x`, {
          method: "POST",
          headers: [
            ["x-admin-token", "one"],
            ["x-admin-token", "two"],
          ],
        }).finally(() => s.close());
      });
    });
    expect(seen).toBe("one, two");
  });

  it("still admits the request when ours came first", async () => {
    expect(await dup(TOKEN, "injected")).toBe(ADMITTED);
  });

  it("still admits it when the inserted one came first", async () => {
    expect(await dup("injected", TOKEN)).toBe(ADMITTED);
  });

  it("does not admit a request where neither value is the token", async () => {
    expect(await dup("injected", "alsowrong")).toBe(REFUSED);
  });

  // Four inserted values, which a count-based bound got wrong: `split(",", 4)`
  // caps the array rather than the number of splits, so ours fell off the end
  // and the gate refused a request that carried the right credential.
  it("finds ours behind four inserted values", async () => {
    expect(await postRaw(["X-Admin-Token: a,b,c,d", `X-Admin-Token: ${TOKEN}`])).toBe(ADMITTED);
  });

  // There is no count left to overrun. Pieces are filtered by length instead,
  // so a header packed with commas costs a string compare each and hides
  // nothing — and Node caps the whole header at 16KB, which bounds the rest.
  it("finds ours behind a header packed with commas", async () => {
    const noise = Array.from({ length: 500 }, (_, i) => `junk${i}`).join(",");
    expect(await postRaw([`X-Admin-Token: ${noise}`, `X-Admin-Token: ${TOKEN}`])).toBe(ADMITTED);
  });

  // The promise the doc comment makes, in the deployment that needs it.
  it("lets a valid Bearer through from behind two wrong X-Admin-Tokens", async () => {
    const status = await postRaw([
      "X-Admin-Token: injected",
      "X-Admin-Token: stale",
      `Authorization: Bearer ${TOKEN}`,
    ]);
    expect(status).toBe(ADMITTED);
  });

  // A comma is not a credential separator on its own. Splitting is a recovery
  // from Node's join, so the value as sent has to be tried whole first — an
  // ADMIN_TOKEN set by hand with a comma in it is refused otherwise.
  it("tries the value as sent before its pieces", async () => {
    expect(await postRaw([`X-Admin-Token: ${TOKEN}`])).toBe(ADMITTED);
    expect(await postRaw([`X-Admin-Token: ${TOKEN},`])).toBe(ADMITTED);
  });
});

// api.ts tells our 401 from an edge's by a field this gate puts in the body,
// and drops the stored admin token only for ours — otherwise a re-provisioned
// site password, which makes Caddy challenge an already-open tab, would read as
// "the admin token was rejected" and silently discard a good one. This pins the
// half of that contract the server owns; client/src/api.test.ts pins the other.
//
// WWW-Authenticate is asserted for a separate reason that still holds: a 401
// carrying it makes the browser raise its own credential prompt, over an API the
// user never asked to log in to.
describe("the 401 the gate sends", () => {
  it("marks itself as ours, and does not make the browser prompt", async () => {
    const res = await fetch(`${base}/api/no-such-route`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    expect(await res.json()).toEqual({
      error: "Admin access required.",
      code: ADMIN_TOKEN_REJECTED,
    });
  });
});
