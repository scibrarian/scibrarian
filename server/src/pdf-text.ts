import fs from "node:fs";
// pdfjs-dist legacy build runs in Node without a worker. (Deliberately not
// pdf-parse: its index.js has a top-level `!module.parent` debug branch that
// crashes with ENOENT under tsx/ESM unless deep-imported.)
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Two readers of the same PDF, with deliberately different appetites.
//
// MATCH_PAGES is a correctness constraint, not a performance one: pdf-match.ts
// scans this text for the paper's own PMID/DOI, and a reference list is full of
// *other papers'* identifiers. Reading further would match a cited paper and
// file the PDF under the wrong article. Three pages is enough for a title page,
// abstract and first-page footer, and stops well short of the bibliography.
const MATCH_PAGES = 3;

// INDEX_PAGES only bounds cost. Full text feeds the search index, where a
// reference list is harmless (nobody searches for a bare PMID) and the body is
// the entire point. Fifty pages covers a journal article and a modest
// supplement; beyond that a document is almost always a book or a data dump,
// where the marginal page adds little and pdfjs costs real time. Text past the
// cap is dropped and the row is flagged truncated rather than silently short.
const INDEX_PAGES = 50;

// Belt-and-braces bound for pathological documents (generated reports, OCR
// layers gone wrong) that stay under the page cap while carrying megabytes of
// text. FTS5 handles large documents fine; this exists so one file can't
// balloon the database or the extraction process's memory.
const MAX_INDEX_CHARS = 2_000_000;

export interface PdfExtract {
  // First MATCH_PAGES pages — the only text pdf-match.ts is allowed to see.
  matchText: string;
  // Up to INDEX_PAGES pages, for the full-text index. Includes matchText.
  fullText: string;
  pages: number; // pages actually read
  truncated: boolean; // document was longer than INDEX_PAGES (or hit the char cap)
}

// C0 control codes, minus tab/newline/carriage-return. A text layer should
// never contain these, but a malformed or hand-built PDF can carry anything —
// and two of them (STX/ETX) are the sentinels the search snippet uses to mark
// matched terms, so a document that contained them could forge a highlight in
// someone else's search results. Stripped at the source, where it also spares
// the FTS tokenizer and the UI from them.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function pageText(content: { items: unknown[] }): string {
  return content.items
    .map((it) => (it && typeof it === "object" && "str" in it ? String(it.str) : ""))
    .join(" ")
    .replace(CONTROL_CHARS, "");
}

// Read both texts from a single document open. Splitting these into two calls
// would parse the same file twice, and the import path needs both.
export async function extractPdf(filePath: string): Promise<PdfExtract> {
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const doc = await getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const pages: string[] = [];
    const last = Math.min(doc.numPages, INDEX_PAGES);
    let chars = 0;
    let hitCharCap = false;
    for (let i = 1; i <= last; i++) {
      const page = await doc.getPage(i);
      const text = pageText(await page.getTextContent());
      page.cleanup();
      pages.push(text);
      chars += text.length;
      if (chars >= MAX_INDEX_CHARS) {
        hitCharCap = true;
        break;
      }
    }
    return {
      matchText: pages.slice(0, MATCH_PAGES).join("\n"),
      fullText: pages.join("\n").slice(0, MAX_INDEX_CHARS),
      pages: pages.length,
      truncated: hitCharCap || doc.numPages > INDEX_PAGES,
    };
  } finally {
    await doc.destroy();
  }
}

// The match-only path, for callers that don't index (kept so the 3-page
// constraint has one named home rather than being a magic argument).
export async function extractPdfText(filePath: string): Promise<string> {
  return (await extractPdf(filePath)).matchText;
}
