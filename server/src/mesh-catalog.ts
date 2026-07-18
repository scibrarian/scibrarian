import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import {
  getMeshVersion,
  meshDescriptorCount,
  replaceMeshData,
  type MeshSeed,
} from "./db.js";
import { errMessage } from "./util.js";

// NLM's yearly MeSH descriptor set. ASCII (d<year>.bin) was discontinued in
// Jan 2026, so we use the gzipped descriptor XML (~30-40 MB) — Node gunzips it
// natively and we stream-parse it, so memory stays bounded.
const MESH_DIR = "https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/";
const descUrl = (year: string): string => `${MESH_DIR}desc${year}.gz`;

// ---------- version detection ----------

// The newest MeSH year NLM currently publishes, or null if unreachable.
async function detectLatestVersion(): Promise<string | null> {
  // Primary: scrape the autoindex for desc<year>.gz and take the newest year.
  try {
    const res = await fetch(MESH_DIR);
    if (res.ok) {
      const html = await res.text();
      let max = 0;
      for (const m of html.matchAll(/desc(\d{4})\.gz/g)) {
        const y = Number(m[1]);
        if (y > max) max = y;
      }
      if (max > 0) return String(max);
    }
  } catch {
    /* fall through to probing */
  }
  // Fallback: probe next calendar year then this one (MeSH year N ships ~Nov N-1).
  const y = new Date().getFullYear();
  for (const year of [y + 1, y]) {
    try {
      const res = await fetch(descUrl(String(year)), { method: "HEAD" });
      if (res.ok) return String(year);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ---------- XML parsing ----------

const RECORD_END = "</DescriptorRecord>";
const UI_RE = /<DescriptorUI>(D\d+)<\/DescriptorUI>/;
const NAME_RE = /<DescriptorName>\s*<String>([\s\S]*?)<\/String>/;
// Each <Term> wraps one <String> (the synonym); the non-greedy gaps skip the
// <TermUI> etc. that precede it. \b keeps <TermList> from matching.
const TERM_RE = /<Term\b[\s\S]*?<String>([\s\S]*?)<\/String>[\s\S]*?<\/Term>/g;

// Decode the five predefined XML entities. &amp; is replaced last so an escaped
// entity like &amp;lt; decodes to the literal text "&lt;", not "<".
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Pull the heading + all entry terms out of one <DescriptorRecord> fragment. The
// first <DescriptorUI> is the record's own (nested UIs, e.g. pharmacological
// actions, come later); the heading is also pushed as an entry term so a search
// on the canonical name matches too.
export function parseDescriptorRecord(fragment: string): MeshSeed | null {
  const uiM = fragment.match(UI_RE);
  const nameM = fragment.match(NAME_RE);
  if (!uiM || !nameM) return null;
  const name = decodeXml(nameM[1]).trim();
  if (!name) return null;
  const terms: string[] = [name];
  for (const m of fragment.matchAll(TERM_RE)) {
    const t = decodeXml(m[1]).trim();
    if (t) terms.push(t);
  }
  return { ui: uiM[1], name, terms };
}

// Stream the descriptor XML and slice out complete <DescriptorRecord> blocks as
// they arrive, so we never hold the whole (~300 MB uncompressed) file. NLM serves
// desc<year>.gz with "Content-Encoding: x-gzip", so Node's fetch usually gunzips
// it for us — but a proxy or a raw-file mirror may not, so we sniff the gzip magic
// bytes on the first chunk and gunzip only when the body is still compressed.
async function streamParseDescriptors(body: ReadableStream<Uint8Array>): Promise<MeshSeed[]> {
  const source = Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);
  const iter = source[Symbol.asyncIterator]();
  const rows: MeshSeed[] = [];

  const first = await iter.next();
  if (first.done) return rows;
  const firstChunk = first.value as Buffer;
  const isGzip = firstChunk.length >= 2 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;

  // Rebuild the byte stream (peeked first chunk + remainder) and, if needed, gunzip.
  const bytes = Readable.from(
    (async function* () {
      yield firstChunk;
      for (let n = await iter.next(); !n.done; n = await iter.next()) yield n.value;
    })()
  );
  const text = isGzip ? bytes.pipe(createGunzip()) : bytes;

  const decoder = new StringDecoder("utf8"); // handles multibyte chars split across chunks
  let buf = "";
  for await (const chunk of text) {
    buf += decoder.write(chunk as Buffer);
    let idx: number;
    while ((idx = buf.indexOf(RECORD_END)) !== -1) {
      const end = idx + RECORD_END.length;
      const rec = parseDescriptorRecord(buf.slice(0, end));
      if (rec) rows.push(rec);
      buf = buf.slice(end);
    }
  }
  return rows;
}

// ---------- load orchestration ----------

let ready = false;
let loading: Promise<void> | null = null;

// Populate (or refresh) the MeSH descriptor list. Runs the version check +
// download at most once per successful process run; on failure it stays retryable
// so a later call (e.g. the first search) can try again. Failures are non-fatal:
// the app works, the topic picker is just empty until a load succeeds.
export function ensureMeshLoaded(): Promise<void> {
  if (ready) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      const latest = await detectLatestVersion();
      if (!latest) {
        if (meshDescriptorCount() > 0) ready = true; // offline, but we have a set to serve
        else console.warn("[mesh] NLM unreachable and no descriptors loaded; topic picker is empty until next startup.");
        return;
      }
      if (meshDescriptorCount() > 0 && getMeshVersion() === latest) {
        ready = true; // already current
        return;
      }
      console.log(`[mesh] downloading NLM MeSH descriptors (version ${latest})…`);
      const res = await fetch(descUrl(latest));
      if (!res.ok || !res.body) throw new Error(`NLM returned ${res.status} ${res.statusText}`);
      const rows = await streamParseDescriptors(res.body);
      replaceMeshData(rows, latest);
      console.log(`[mesh] loaded: ${rows.length} descriptors (version ${latest})`);
      ready = true;
    } catch (err) {
      console.warn("[mesh] descriptor load failed:", errMessage(err));
    } finally {
      loading = null;
    }
  })();
  return loading;
}
