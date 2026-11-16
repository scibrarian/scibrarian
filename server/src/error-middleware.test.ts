import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb } from "./test-db.js";
import { GENERIC_SERVER_ERROR } from "./util.js";

// What the error middleware at the end of index.ts answers with, and what it
// logs: a refusal answers with its reason and is not logged, and a server error
// answers with the generic body and logs its real cause.
//
// Over HTTP against the real app, because the middleware is a position in the
// stack and nothing else reaches it.

// config.ts reads ADMIN_TOKEN at import time and vitest shares one process
// across files, so this is set rather than assumed — see reset-route.test.ts.
process.env.ADMIN_TOKEN = "error-middleware-token";
const HEADERS = { "x-admin-token": "error-middleware-token", "content-type": "application/json" };

// A fault to throw from GET /settings, standing in for anything a route didn't
// expect: a SQLite error, a missing file.
const fault = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("./settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings.js")>();
  return {
    ...actual,
    settingsView: () => {
      if (fault.error) throw fault.error;
      return actual.settingsView();
    },
  };
});

let server: Server;
let base: string;

const request = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/api${path}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  await openTempDb("error-middleware");
  // index.ts builds the app at module scope and only listens inside start(),
  // so importing it gives the whole middleware stack with nothing running.
  const { app } = await import("./index.js");
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

afterEach(() => {
  fault.error = null;
  vi.restoreAllMocks();
});

const logged = (warn: ReturnType<typeof vi.spyOn>) =>
  warn.mock.calls.map((args) => String(args[0])).filter((line) => line.startsWith("[server]"));

describe("the error middleware", () => {
  it("answers a refusal with its reason, and doesn't log it", async () => {
    const warn = vi.spyOn(console, "warn");
    const res = await request("PUT", "/settings", { poll_cron: "every morning" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That isn't a valid cron expression." });
    expect(logged(warn)).toEqual([]);
  });

  it("answers a server error with the generic body, and logs its cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fault.error = new Error("SQLITE_IOERR: disk I/O error at /home/reader/library.db");
    const res = await request("GET", "/settings");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: GENERIC_SERVER_ERROR });
    expect(logged(warn)).toEqual(["[server] SQLITE_IOERR: disk I/O error at /home/reader/library.db"]);
  });
});
