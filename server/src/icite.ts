import type { CitationInfo } from "./db.js";

// NIH iCite: free, no API key. Returns per-paper citation_count (for node size)
// and references (PMIDs the paper cites, used to derive intra-dataset edges).
//   https://icite.od.nih.gov/api/pubs?pmids=<comma-separated>
const ICITE = "https://icite.od.nih.gov/api/pubs";
const BATCH_SIZE = 200; // keep the request URL comfortably short
const MIN_GAP_MS = 150; // be polite to the shared NIH service

interface ICitePub {
  pmid?: number | string;
  citation_count?: number | null;
  references?: (number | string)[] | string | null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// iCite returns references as an int array, but tolerate a space/comma string too.
function normalizeRefs(refs: ICitePub["references"]): string[] {
  if (!refs) return [];
  const list = Array.isArray(refs) ? refs : String(refs).split(/[\s,]+/);
  return list.map((r) => String(r).trim()).filter(Boolean);
}

export async function fetchCitations(pmids: string[]): Promise<Map<string, CitationInfo>> {
  const out = new Map<string, CitationInfo>();
  if (pmids.length === 0) return out;

  let first = true;
  for (const batch of chunk(pmids, BATCH_SIZE)) {
    if (!first) await new Promise((r) => setTimeout(r, MIN_GAP_MS));
    first = false;

    const url = `${ICITE}?pmids=${batch.join(",")}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`iCite returned ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { data?: ICitePub[] };
    for (const pub of data.data ?? []) {
      if (pub.pmid == null) continue;
      out.set(String(pub.pmid), {
        citation_count: Number(pub.citation_count) || 0,
        references: normalizeRefs(pub.references),
      });
    }
  }
  return out;
}
