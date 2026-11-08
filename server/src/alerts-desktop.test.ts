import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// The desktop half of email alerts, which is that there are none. The app polls
// while its window is open and catches up the moment it launches, so whoever
// the email would reach is already looking at the feed. alerts.test.ts runs as
// a server; this file is the packaged app, and settings left over from a server
// database — alerts on, a mail server set — must still send nothing.

// Read once by config.ts, at import: the same "1" electron/main.mjs writes.
process.env.SCIBRARIAN_DESKTOP = "1";
process.env.ADMIN_TOKEN = "";

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (message: unknown) => {
        sent.push(message);
      },
      close: () => {},
    }),
  },
}));
vi.mock("./pubmed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pubmed.js")>()),
  searchWithTotal: async () => ({ ids: [], total: 0 }),
}));

let db: Db;
let server: Server;
let base: string;

beforeAll(async () => {
  db = await openTempDb("alerts-desktop");
  for (const [key, value] of Object.entries({
    alert_email_enabled: "1",
    alert_email_to: "reader@example.org",
    smtp_host: "smtp.example.org",
    smtp_user: "sender@example.org",
  })) {
    db.setSetting(key as Parameters<Db["setSetting"]>[0], value);
  }
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

describe("email alerts in the desktop app", () => {
  it("sends nothing after a scheduled check, whatever the settings say", async () => {
    const { sendPollAlert } = await import("./alerts.js");
    await sendPollAlert([
      {
        result: { topicId: 1, topicName: "Sleep", found: 0, added: 0, error: "NCBI unreachable" },
        addedPmids: [],
        history: null,
        backCatalog: null,
      },
    ]);
    expect(sent).toEqual([]);
  });

  it("has no test email to send", async () => {
    const res = await fetch(`${base}/api/settings/test-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(sent).toEqual([]);
  });
});
