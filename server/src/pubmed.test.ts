import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTempDb, openTempDb, type Db } from "./test-db.js";

// The NCBI adapter's request loop: what every PubMed call goes through on its
// way to E-utilities, and what it does when E-utilities misbehaves. Parsing what
// comes back is pubmed-parse.test's; everything else that calls PubMed in a test
// talks to a fake. So this is the one place the retries, the waits and the
// errors written for a reader are pinned, against the real code, with no NCBI
// on the other end.
//
// fetchWithTimeout is the seam: each test queues the replies its requests get,
// and every request records when it went out, on a fake clock the test runs to
// the end with settled().

const net = vi.hoisted(() => ({
  replies: [] as (() => Response)[],
  asked: [] as { url: URL; at: number }[],
}));
vi.mock("./http.js", () => ({
  fetchWithTimeout: async (url: string) => {
    net.asked.push({ url: new URL(url), at: Date.now() });
    const reply = net.replies.shift();
    if (!reply) throw new Error("the test queued no reply for this request");
    return reply();
  },
}));

const json = (body: unknown) => () => Response.json(body);
const text = (body: string) => () => new Response(body);
const status =
  (code: number, statusText = "", headers: Record<string, string> = {}) =>
  () =>
    new Response("", { status: code, statusText, headers });
// A connection that drops before the headers, as undici reports it.
const dropped = () => () => {
  throw new TypeError("fetch failed");
};
// Headers that arrive, then a body that never finishes.
const stalled = () => () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    })
  );
const counted = (count: number) => json({ esearchresult: { count: String(count) } });

const gaps = () => net.asked.slice(1).map((r, i) => r.at - net.asked[i].at);

// A request run to its end, through every gap and backoff it waits out. The
// rejection handler is only there so a failure waiting for the timers isn't
// reported as unhandled; the caller still awaits the work itself.
async function settled<T>(work: Promise<T>): Promise<T> {
  work.catch(() => {});
  await vi.runAllTimersAsync();
  return work;
}

let db: Db;
let pubmed: typeof import("./pubmed.js");
// The throttle remembers when the last request went out, for the whole file.
// Each test starts an hour after the one before, so none waits on another's.
let clock = Date.parse("2026-01-01T00:00:00Z");

beforeAll(async () => {
  db = await openTempDb("pubmed");
  pubmed = await import("./pubmed.js");
});

afterAll(() => {
  closeTempDb();
});

beforeEach(() => {
  clock += 3_600_000;
  vi.useFakeTimers({ now: clock });
  net.replies = [];
  net.asked = [];
  db.setSetting("ncbi_api_key", "");
  db.setSetting("ncbi_email", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a request NCBI turns away for now", () => {
  it.each([429, 500, 502, 503, 504])("asks again after a %i, and answers with what that got", async (code) => {
    net.replies = [status(code), counted(7)];
    expect(await settled(pubmed.countMatches("x"))).toBe(7);
    expect(net.asked).toHaveLength(2);
  });

  it("waits as long as Retry-After says, in seconds or as a date", async () => {
    net.replies = [
      status(429, "Too Many Requests", { "retry-after": "3" }),
      () => status(429, "Too Many Requests", { "retry-after": new Date(Date.now() + 5000).toUTCString() })(),
      counted(1),
    ];
    await settled(pubmed.countMatches("x"));
    const [seconds, date] = gaps();
    expect(seconds).toBeGreaterThanOrEqual(3000);
    expect(date).toBeGreaterThanOrEqual(4000);
  });

  it("backs off longer each time, then gives up saying what NCBI answered", async () => {
    net.replies = Array.from({ length: 5 }, () => status(503, "Service Unavailable"));
    await expect(settled(pubmed.countMatches("x"))).rejects.toMatchObject({
      message: "NCBI esearch.fcgi returned 503 Service Unavailable",
      expose: true,
    });
    // Four retries, each waiting twice the last, plus up to a quarter second.
    expect(net.asked).toHaveLength(5);
    gaps().forEach((gap, i) => {
      expect(gap).toBeGreaterThanOrEqual(500 * 2 ** i);
      expect(gap).toBeLessThan(500 * 2 ** i + 250);
    });
  });

  it("doesn't ask again after a status that won't change", async () => {
    net.replies = [status(400, "Bad Request")];
    await expect(settled(pubmed.countMatches("x"))).rejects.toThrow(
      "NCBI esearch.fcgi returned 400 Bad Request"
    );
    expect(net.asked).toHaveLength(1);
  });
});

describe("a request that never arrives", () => {
  it("asks again after a dropped connection", async () => {
    net.replies = [dropped(), counted(2)];
    expect(await settled(pubmed.countMatches("x"))).toBe(2);
  });

  // What a poll or an import reports on a PubMed outage, and the failure
  // either one meets most: written for the reader, with undici's words logged.
  it("says PubMed couldn't be reached once four retries have dropped too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    net.replies = Array.from({ length: 5 }, dropped);
    await expect(settled(pubmed.countMatches("x"))).rejects.toMatchObject({
      message: "Couldn't reach PubMed (esearch.fcgi). Try again in a minute.",
      expose: true,
    });
    expect(net.asked).toHaveLength(5);
    expect(String(warn.mock.calls[0][0])).toContain("fetch failed");
  });

  it("asks again after a body that stalls part way, as it does a dropped connection", async () => {
    net.replies = [stalled(), counted(3)];
    expect(await settled(pubmed.countMatches("x"))).toBe(3);
  });

  it("says PubMed's response couldn't be read once four retries have stalled too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    net.replies = Array.from({ length: 5 }, stalled);
    await expect(settled(pubmed.countMatches("x"))).rejects.toMatchObject({
      message: "Couldn't read PubMed's response (esearch.fcgi). Try again in a minute.",
      expose: true,
    });
    expect(net.asked).toHaveLength(5);
  });
});

// Neither is retried: an answer NCBI meant to give won't change by asking again.
describe("an error NCBI states inside a 200", () => {
  it("reports what NCBI said when its error broke the JSON", async () => {
    // A backend exception interpolated raw, newline and all.
    net.replies = [text('{"esearchresult": {"ERROR": "Search Backend failed:\n   timeout"}}')];
    await expect(settled(pubmed.countMatches("x"))).rejects.toMatchObject({
      message: "PubMed rejected the esearch request: Search Backend failed: timeout",
      expose: true,
    });
    expect(net.asked).toHaveLength(1);
  });

  it("says the body wasn't JSON when it states nothing", async () => {
    net.replies = [text("<html>Bad gateway</html>")];
    await expect(settled(pubmed.countMatches("x"))).rejects.toThrow(
      "NCBI esearch.fcgi returned a response that isn't valid JSON."
    );
  });

  // Left alone this reads as a search that matched nothing, and a broken query
  // as a topic that never has new papers.
  it("reports an error in JSON that parsed, rather than answering that nothing matched", async () => {
    net.replies = [json({ esearchresult: { ERROR: "Invalid query" } })];
    await expect(settled(pubmed.pmidsForDoi("10.1000/x"))).rejects.toMatchObject({
      message: "PubMed rejected the esearch request: Invalid query",
      expose: true,
    });
    expect(net.asked).toHaveLength(1);
  });
});

describe("what every request carries", () => {
  it("names the tool, and sends the reader's email and API key when they gave them", async () => {
    db.setSetting("ncbi_email", "reader@example.org");
    db.setSetting("ncbi_api_key", "KEY");
    net.replies = [counted(0)];
    await settled(pubmed.countMatches("x"));
    const params = net.asked[0].url.searchParams;
    expect(params.get("tool")).toBe("scibrarian");
    expect(params.get("email")).toBe("reader@example.org");
    expect(params.get("api_key")).toBe("KEY");
  });

  it("sends neither when they didn't", async () => {
    net.replies = [counted(0)];
    await settled(pubmed.countMatches("x"));
    const params = net.asked[0].url.searchParams;
    expect(params.get("tool")).toBe("scibrarian");
    expect(params.has("email")).toBe(false);
    expect(params.has("api_key")).toBe(false);
  });
});

// NCBI allows about three requests a second without a key and ten with one,
// across everything this server asks at once.
describe("the gap between requests", () => {
  it("leaves 400ms between requests made together without an API key", async () => {
    net.replies = [counted(1), counted(2), counted(3)];
    await settled(Promise.all(["a", "b", "c"].map((t) => pubmed.countMatches(t))));
    expect(gaps()).toHaveLength(2);
    for (const gap of gaps()) expect(gap).toBeGreaterThanOrEqual(400);
  });

  it("leaves 110ms with one", async () => {
    db.setSetting("ncbi_api_key", "KEY");
    net.replies = [counted(1), counted(2), counted(3)];
    await settled(Promise.all(["a", "b", "c"].map((t) => pubmed.countMatches(t))));
    expect(gaps()).toHaveLength(2);
    for (const gap of gaps()) {
      expect(gap).toBeGreaterThanOrEqual(110);
      expect(gap).toBeLessThan(400);
    }
  });
});
