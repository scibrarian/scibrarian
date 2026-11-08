import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";
import { article } from "./unheld-sweep-fixture.js";

// Email alerts after an unattended poll — see alerts.ts.
//
// What matters is the shape of the run, not the wording: one email however
// many topics there are, a paper two topics found listed once, a topic that
// read its history summed up rather than listed, a failure reported even when
// nothing was found, and nothing at all from a run with nothing to say or from
// a manual check. Each of those is a branch that compiles just as well the
// other way round, and every one of them is the difference between the email
// this replaces and the one it was meant to be.
//
// PubMed, iCite and the mail server are stood in for, so no test here touches
// the network. The stand-in transport records what it was asked to send.

// Read once, at import, by config.ts; set here so a desktop run elsewhere in
// the process can't leave this file testing the build that sends nothing.
delete process.env.SCIBRARIAN_DESKTOP;
process.env.ADMIN_TOKEN = "alerts-token";
const HEADERS = { "x-admin-token": "alerts-token", "content-type": "application/json" };

const ncbi = vi.hoisted(() => ({
  fail: false,
  // What a search answers, by whether its term names the topic's heading.
  answers: new Map<string, string[]>(),
}));
vi.mock("./pubmed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pubmed.js")>();
  return {
    ...actual,
    searchWithTotal: async (term: string) => {
      if (ncbi.fail) throw new Error("NCBI unreachable");
      for (const [heading, ids] of ncbi.answers) {
        if (term.includes(heading)) return { ids, total: ids.length };
      }
      return { ids: [], total: 0 };
    },
    fetchArticles: async (pmids: string[]) => pmids.map(paper),
  };
});
vi.mock("./icite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./icite.js")>()),
  ensureCitations: async () => {},
}));

const mail = vi.hoisted(() => ({
  sent: [] as { from: unknown; to: string; subject: string; text: string; html?: string }[],
  options: [] as Record<string, unknown>[],
  // Thrown by sendMail when set, as nodemailer's own errors are: an Error
  // carrying a code and the server's reply.
  error: null as (Error & { code?: string; response?: string }) | null,
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      mail.options.push(options);
      return {
        sendMail: async (message: (typeof mail.sent)[number]) => {
          if (mail.error) throw mail.error;
          mail.sent.push(message);
        },
        close: () => {},
      };
    },
  },
}));

// A paper with a title worth finding in the email, and a date to sort it by.
function paper(pmid: string) {
  return { ...article(pmid), title: `Title ${pmid}`, pub_date: `2026-10-${pmid.slice(-2)}` };
}

let db: Db;
let server: Server;
let base: string;
let poller: typeof import("./poller.js");

// A topic past its first poll, so the next one is incremental and lists what
// it finds. `heading` is what the stand-in search keys its answer on.
async function polledTopic(name: string, heading: string) {
  const t = db.createTopic(name, `"${heading}"[MeSH]`, [], { allPubmed: true });
  await poller.pollTopic(t.id);
  return t;
}

function configure(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    alert_email_enabled: "1",
    alert_email_to: "reader@example.org",
    smtp_host: "smtp.example.org",
    smtp_port: "",
    smtp_user: "sender@example.org",
    smtp_pass: "secret",
    smtp_from: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    db.setSetting(key as Parameters<Db["setSetting"]>[0], value);
  }
}

const put = (body: unknown) =>
  fetch(`${base}/api/settings`, { method: "PUT", headers: HEADERS, body: JSON.stringify(body) });
const testEmail = (body: unknown) =>
  fetch(`${base}/api/settings/test-email`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  db = await openTempDb("alerts");
  poller = await import("./poller.js");
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

beforeEach(() => {
  db.db.exec("DELETE FROM topics; DELETE FROM articles;");
  ncbi.fail = false;
  ncbi.answers.clear();
  mail.sent = [];
  mail.options = [];
  mail.error = null;
  configure();
});

describe("what a scheduled check sends", () => {
  it("sends one email for the run, listing a paper two topics found once", async () => {
    await polledTopic("Sleep", "Sleep");
    await polledTopic("Obesity", "Obesity");
    ncbi.answers.set("Sleep", ["40000001", "40000002"]);
    ncbi.answers.set("Obesity", ["40000002", "40000003"]);

    await poller.runPoll("scheduled");

    expect(mail.sent).toHaveLength(1);
    const [email] = mail.sent;
    expect(email.to).toBe("reader@example.org");
    expect(email.subject).toBe("Scibrarian: 3 new papers");
    // Under the first topic that found it, naming the other; and only there.
    expect(email.text.split("Title 40000002")).toHaveLength(2);
    const [sleep, obesity] = email.text.split("Obesity — ");
    expect(sleep).toContain("Sleep — 2 new papers");
    expect(sleep).toContain("Also in: Obesity");
    expect(obesity).toContain("Title 40000003");
    expect(obesity).toContain("Plus 1 listed above, under another topic.");
  });

  it("lists a topic's papers newest first, up to its cap, and counts the rest", async () => {
    await polledTopic("Sleep", "Sleep");
    const ids = Array.from({ length: 25 }, (_, i) => String(40000001 + i));
    ncbi.answers.set("Sleep", ids);

    await poller.runPoll("scheduled");

    const { text } = mail.sent[0];
    expect(text).toContain("Sleep — 25 new papers");
    expect(text).toContain("…and 5 more in Scibrarian.");
    expect(text.indexOf("Title 40000025")).toBeLessThan(text.indexOf("Title 40000024"));
    expect(text).not.toContain("Title 40000005");
  });

  it("sums up a topic's first check rather than listing its whole history", async () => {
    ncbi.answers.set("Sleep", ["40000001", "40000002"]);
    db.createTopic("Sleep", '"Sleep"[MeSH]', [], { allPubmed: true });

    await poller.runPoll("scheduled");

    const { subject, text } = mail.sent[0];
    // Not "2 new papers": a first check can add thousands, none of them news.
    expect(subject).toBe("Scibrarian: 1 topic checked in full");
    expect(text).toContain("2 papers from a full check of its history");
    expect(text).not.toContain("Title 40000001");
  });

  it("reports a topic that couldn't be checked, with nothing new to go with it", async () => {
    await polledTopic("Sleep", "Sleep");
    ncbi.fail = true;

    await poller.runPoll("scheduled");

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe("Scibrarian: 1 topic couldn't be checked");
    expect(mail.sent[0].text).toContain("Needs attention\n- Sleep couldn't be checked:");
  });

  it("escapes what it puts in the HTML", async () => {
    await polledTopic("Sleep <b>", "Sleep");
    ncbi.answers.set("Sleep", ["40000001"]);

    await poller.runPoll("scheduled");

    expect(mail.sent[0].html).toContain("Sleep &lt;b&gt;");
    expect(mail.sent[0].html).not.toContain("<b>");
  });
});

describe("when nothing is sent", () => {
  it("sends nothing for a run that found nothing", async () => {
    await polledTopic("Sleep", "Sleep");
    await poller.runPoll("scheduled");
    expect(mail.sent).toEqual([]);
  });

  it("sends nothing with alerts off", async () => {
    await polledTopic("Sleep", "Sleep");
    configure({ alert_email_enabled: "0" });
    ncbi.answers.set("Sleep", ["40000001"]);
    await poller.runPoll("scheduled");
    expect(mail.sent).toEqual([]);
  });

  // The reader asked for that check and is watching the page it answers.
  it("sends nothing for a manual check", async () => {
    const t = await polledTopic("Sleep", "Sleep");
    ncbi.answers.set("Sleep", ["40000001"]);
    const res = await fetch(`${base}/api/refresh?topic=${t.id}`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(200);
    expect(mail.sent).toEqual([]);
  });

  // runPoll never rejects whatever happens, so what's pinned is whose failure
  // the log calls it: a mail server being down is not the poll failing.
  it("logs a refused email as the email's failure, not the poll's", async () => {
    await polledTopic("Sleep", "Sleep");
    ncbi.answers.set("Sleep", ["40000001"]);
    mail.error = Object.assign(new Error("Connection refused"), { code: "ECONNECTION" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await poller.runPoll("scheduled");
      expect(warn).toHaveBeenCalledWith(
        "[alerts] couldn't send the poll email: Connection refused"
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe("the settings", () => {
  it("won't turn alerts on without somewhere to send them", async () => {
    configure({ alert_email_enabled: "0", smtp_host: "" });
    const res = await put({ alert_email_enabled: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Add the mail server to send through.");
    expect(db.getSettings().alert_email_enabled).toBe("0");
  });

  it("keeps the password write-only", async () => {
    const res = await put({ smtp_host: "mail.example.org", smtp_pass: "another" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.has_smtp_pass).toBe(true);
    expect(body).not.toHaveProperty("smtp_pass");
    expect(JSON.stringify(body)).not.toContain("another");
    expect(db.getSettings().smtp_pass).toBe("another");
  });

  // nodemailer would refuse every send before reaching the server, while the
  // switch said On.
  it("won't turn alerts on with a username but no password", async () => {
    configure({ alert_email_enabled: "0", smtp_pass: "" });
    const res = await put({ alert_email_enabled: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Add the password, or clear the username if the mail server needs no login."
    );
    expect(db.getSettings().alert_email_enabled).toBe("0");
  });

  // Each is read by nodemailer as something other than the one address typed.
  it.each([
    "me@lab.org,boss",
    "me@lab.org;boss@x.org",
    '"boss@x.org"me@lab.org',
    "me(boss@x.org)@lab.org",
    "me@lab.org:boss",
    "me\\,x@lab.org",
  ])("refuses %s as the address to send to", async (address) => {
    const res = await put({ alert_email_to: address });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("The address to send alerts to isn't an email address.");
    expect(db.getSettings().alert_email_to).toBe("reader@example.org");
  });

  it.each(["first.last+tag@sub.example.co.uk", "o'brien@example.ie", "me@[192.0.2.1]"])(
    "takes %s as the address to send to",
    async (address) => {
      const res = await put({ alert_email_to: address });
      expect(res.status).toBe(200);
      expect(db.getSettings().alert_email_to).toBe(address);
    }
  );

  // With alerts off too: saved, the moved login would keep the old password,
  // and send it to the new server once alerts went on.
  it("won't save a new server without its password", async () => {
    configure({ alert_email_enabled: "0" });
    const res = await put({ smtp_host: "mail.elsewhere.org" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Enter the password for the new mail server.");
    expect(db.getSettings().smtp_host).toBe("smtp.example.org");
  });

  it("keeps a password's leading and trailing spaces", async () => {
    const res = await put({ smtp_pass: " spaced out " });
    expect(res.status).toBe(200);
    expect(db.getSettings().smtp_pass).toBe(" spaced out ");
  });

  it("refuses a port that isn't one", async () => {
    const res = await put({ smtp_port: "smtp" });
    expect(res.status).toBe(400);
  });
});

describe("the test email", () => {
  it("sends with the dialog's values and the stored password", async () => {
    const res = await testEmail({
      alert_email_to: "someone@example.org",
      smtp_host: "smtp.example.org",
      smtp_port: "465",
      smtp_user: "sender@example.org",
      smtp_from: "",
    });
    expect(res.status).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe("someone@example.org");
    expect(mail.sent[0].from).toEqual({ name: "Scibrarian", address: "sender@example.org" });
    expect(mail.options[0]).toMatchObject({
      host: "smtp.example.org",
      port: 465,
      secure: true,
      auth: { user: "sender@example.org", pass: "secret" },
    });
  });

  // Otherwise the stored password goes to whatever server the request names,
  // which would let an admin read the write-only secret back.
  it("won't send the stored password to another server", async () => {
    const res = await testEmail({ smtp_host: "mail.elsewhere.org" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Enter the password for the new mail server.");
    expect(mail.options).toEqual([]);
  });

  it("won't send the stored password with another username", async () => {
    const res = await testEmail({ smtp_user: "someone-else@example.org" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Enter the password for the new username.");
    expect(mail.options).toEqual([]);
  });

  it("sends to another server with the password typed for it", async () => {
    const res = await testEmail({ smtp_host: "mail.elsewhere.org", smtp_pass: "theirs" });
    expect(res.status).toBe(200);
    expect(mail.options[0]).toMatchObject({
      host: "mail.elsewhere.org",
      auth: { user: "sender@example.org", pass: "theirs" },
    });
  });

  it("sends to another server without a password when there's no username", async () => {
    const res = await testEmail({
      smtp_host: "relay.elsewhere.org",
      smtp_user: "",
      smtp_from: "sender@example.org",
    });
    expect(res.status).toBe(200);
    expect(mail.options[0]).toMatchObject({ host: "relay.elsewhere.org", auth: undefined });
  });

  // Not "the mail server didn't accept that username and password": no
  // password was ever sent.
  it("asks for the password a username needs, rather than trying without", async () => {
    configure({ smtp_pass: "" });
    const res = await testEmail({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Add the password, or clear the username if the mail server needs no login."
    );
    expect(mail.options).toEqual([]);
  });

  it("sends through a relay with neither username nor password", async () => {
    configure({ smtp_user: "", smtp_pass: "", smtp_from: "sender@example.org" });
    const res = await testEmail({});
    expect(res.status).toBe(200);
    expect(mail.options[0]).toMatchObject({ auth: undefined, requireTLS: false });
  });

  it("treats the server's name the same whatever its case", async () => {
    const res = await testEmail({ smtp_host: "SMTP.Example.org" });
    expect(res.status).toBe(200);
    expect(mail.options[0]).toMatchObject({ auth: { pass: "secret" } });
  });

  // A password must never go over a connection that was never encrypted.
  it("requires STARTTLS on any other port once there is a password", async () => {
    await testEmail({ smtp_port: "587" });
    expect(mail.options[0]).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it("says what the mail server objected to", async () => {
    mail.error = Object.assign(new Error("Invalid login"), {
      code: "EAUTH",
      response: "535 5.7.8 Username and Password not accepted",
    });
    const res = await testEmail({});
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "The mail server didn't accept that username and password. " +
        "The server said: 535 5.7.8 Username and Password not accepted"
    );
  });

  it("asks for a From address when the username isn't one", async () => {
    const res = await testEmail({ smtp_user: "apikey", smtp_pass: "key" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Add a From address — the username isn't an email address."
    );
    expect(mail.sent).toEqual([]);
  });
});
