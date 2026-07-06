import fs from "node:fs";
// pdfjs-dist legacy build runs in Node without a worker. (Deliberately not
// pdf-parse: its index.js has a top-level `!module.parent` debug branch that
// crashes with ENOENT under tsx/ESM unless deep-imported.)
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Extract the text layer of the first few pages — enough to find the paper's
// own PMID/DOI while keeping reference lists (other papers' ids) out of reach.
export async function extractPdfText(filePath: string, maxPages = 3): Promise<string> {
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const doc = await getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const pages: string[] = [];
    const last = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= last; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
      page.cleanup();
    }
    return pages.join("\n");
  } finally {
    await doc.destroy();
  }
}
