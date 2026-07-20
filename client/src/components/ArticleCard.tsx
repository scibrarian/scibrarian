import { useEffect, useState } from "react";
import type { Paper } from "../types";
import { api } from "../api";
import { formatAuthors } from "../lib/format";
import { openTitle, type PaperOpener } from "../lib/openPaper";

const ABSTRACT_PREVIEW = 320;

// Abstracts aren't in the papers list payload (they'd dominate its size), so
// each card fetches its own by pmid. Cache per pmid so re-renders and re-scrolls
// (the Timeline mounts/unmounts cards as you scroll) don't refetch.
const abstractCache = new Map<string, string>();

export function ArticleCard({ article, opener }: { article: Paper; opener: PaperOpener }) {
  const [expanded, setExpanded] = useState(false);
  // null = still loading; "" = loaded, no abstract available.
  const [abstract, setAbstract] = useState<string | null>(
    () => abstractCache.get(article.pmid) ?? null
  );

  useEffect(() => {
    const cached = abstractCache.get(article.pmid);
    if (cached !== undefined) {
      setAbstract(cached);
      return;
    }
    setAbstract(null);
    let active = true;
    api
      .getAbstract(article.pmid)
      .then((r) => {
        abstractCache.set(article.pmid, r.abstract);
        if (active) setAbstract(r.abstract);
      })
      .catch(() => {
        if (active) setAbstract(""); // treat a failed fetch as "no abstract"
      });
    return () => {
      active = false;
    };
  }, [article.pmid]);

  const loading = abstract === null;
  const longAbstract = !!abstract && abstract.length > ABSTRACT_PREVIEW;
  const shown =
    !abstract || expanded || !longAbstract
      ? abstract ?? ""
      : abstract.slice(0, ABSTRACT_PREVIEW).trimEnd() + "…";

  return (
    <article className="card">
      <div className="card-meta">
        <span className="journal-badge">{article.journal_name || "Unknown journal"}</span>
        <span className="card-date">{article.pub_date_display || article.pub_date}</span>
      </div>
      <h3 className="card-title">
        <button
          className="paper-open"
          onClick={() => opener.openPaper(article)}
          title={openTitle(article, opener.opensStoredPdf)}
        >
          {/* Inside the button so it flows with the title's first line — a
              button is an atomic inline, so a sibling badge gets pushed to its
              own line. The button's own title attribute names the file. */}
          {opener.opensStoredPdf(article) && (
            <span className="file-badge" aria-hidden="true">
              📄
            </span>
          )}
          {article.title || "(untitled)"}
        </button>
        {article.file_id != null && !article.file_exists && (
          <span className="file-missing" title="The stored PDF is missing">
            file missing
          </span>
        )}
      </h3>
      {article.authors.length > 0 && (
        <p className="card-authors">{formatAuthors(article.authors, 4)}</p>
      )}
      {loading ? (
        <p className="card-abstract muted">Loading abstract…</p>
      ) : abstract ? (
        <div className="card-abstract">
          <span className="abstract-text">{shown}</span>{" "}
          {longAbstract && (
            <button className="link-btn" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      ) : (
        <p className="card-abstract muted">No abstract available.</p>
      )}
      <div className="card-links">
        <a href={article.url} target="_blank" rel="noreferrer">
          PubMed ↗
        </a>
        {article.doi && (
          <a href={`https://doi.org/${article.doi}`} target="_blank" rel="noreferrer">
            DOI ↗
          </a>
        )}
      </div>
    </article>
  );
}
