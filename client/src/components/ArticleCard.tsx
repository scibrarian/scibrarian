import { useState } from "react";
import type { Paper } from "../types";
import { formatAuthors } from "../lib/format";

const ABSTRACT_PREVIEW = 320;

export function ArticleCard({ article }: { article: Paper }) {
  const [expanded, setExpanded] = useState(false);
  const longAbstract = article.abstract.length > ABSTRACT_PREVIEW;
  const shown =
    expanded || !longAbstract
      ? article.abstract
      : article.abstract.slice(0, ABSTRACT_PREVIEW).trimEnd() + "…";

  return (
    <article className="card">
      <div className="card-meta">
        <span className="journal-badge">{article.journal_name || "Unknown journal"}</span>
        <span className="card-date">{article.pub_date_display || article.pub_date}</span>
      </div>
      <h3 className="card-title">
        <a href={article.url} target="_blank" rel="noreferrer">
          {article.title || "(untitled)"}
        </a>
      </h3>
      {article.authors.length > 0 && (
        <p className="card-authors">{formatAuthors(article.authors, 4)}</p>
      )}
      {article.abstract ? (
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
