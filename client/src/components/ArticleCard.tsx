import { useLayoutEffect, useRef, useState } from "react";
import { FileText, ExternalLink } from "lucide-react";
import type { Paper } from "../types";
import type { Bookmarking } from "../lib/bookmarking";
import { formatAuthors } from "../lib/format";
import { openTitle, type PaperOpener } from "../lib/openPaper";
import { BookmarkMenu } from "./BookmarkMenu";
import { ProvenanceBadges } from "./ProvenanceBadges";
import { SkeletonBar } from "./Skeleton";
import { Snippet } from "./Snippet";

export function ArticleCard({
  article,
  abstract,
  opener,
  bookmarking,
  onError,
  onNewFolder,
}: {
  article: Paper;
  // Abstracts aren't in the papers list payload (they'd dominate its size), so
  // the timeline fetches them for the whole rendered chunk at once and hands
  // each card its own — undefined while that request is still out, "" for a
  // paper with none stored.
  abstract: string | undefined;
  opener: PaperOpener;
  // null where the workspace doesn't bookmark, or for a viewer who can't write.
  bookmarking: Bookmarking | null;
  onError: (message: string) => void;
  // Naming a new folder belongs to the timeline, not the card: one prompt for
  // the whole list instead of one behind every card's menu.
  onNewFolder: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Whether the clamped text is actually hiding anything, and so whether to
  // offer "Show more". Measured rather than inferred from a character count:
  // how much text fits in three lines depends on the card's width, and a count
  // that guessed wrong would either hide text with no way to reach it or offer
  // to expand text that is already whole.
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);

  const loading = abstract === undefined;

  // Re-measured on width changes too — narrowing the card can push text that
  // fitted in three lines out of them, and "Show more" has to appear with it.
  // Skipped while expanded (nothing is clamped then), which leaves the flag at
  // the true it must have had to get there.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || !abstract || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [abstract, expanded]);

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
              <FileText size={14} />
            </span>
          )}
          {article.title || "(untitled)"}
        </button>
        {article.file_id != null && !article.file_exists && (
          <span className="file-missing" title="The stored PDF is missing">
            file missing
          </span>
        )}
        <ProvenanceBadges entries={article.provenance} />
      </h3>
      {article.authors.length > 0 && (
        <p className="card-authors">{formatAuthors(article.authors, 4)}</p>
      )}
      {/* Exactly one block of prose per card, in one slot. When the search
          matched inside the PDF, the excerpt *replaces* the abstract rather than
          stacking above it: two runs of grey body text read as a single
          paragraph, and of the two, the excerpt is the one that answers "why is
          this card in my results?". A card matched only on metadata has no
          excerpt and keeps its abstract, so the slot always holds whichever text
          is actually relevant — and the timeline never shows two card shapes for
          the same reason. */}
      {article.snippet ? (
        <Snippet text={article.snippet} className="paper-snippet card-snippet" />
      ) : (
        /* One block whichever state we're in, and it reserves the collapsed
           height up front — the abstract arrives after the card is already on
           screen, so a block that grew to fit it would shunt every card below
           this one down the timeline as you read. */
        <div className="card-abstract">
          {loading ? (
            <div className="abstract-skeleton" aria-hidden="true">
              <SkeletonBar w="100%" h={12} />
              <SkeletonBar w="100%" h={12} />
              <SkeletonBar w="58%" h={12} />
            </div>
          ) : abstract ? (
            <>
              <span
                ref={textRef}
                className={expanded ? "abstract-text" : "abstract-text clamped"}
              >
                {abstract}
              </span>
              {overflows && (
                <button className="link-btn" onClick={() => setExpanded(!expanded)}>
                  {expanded ? "Show less" : "Show more"}
                </button>
              )}
            </>
          ) : (
            <span className="abstract-empty">No abstract available.</span>
          )}
        </div>
      )}
      <div className="card-links">
        <a href={article.url} target="_blank" rel="noreferrer">
          PubMed <ExternalLink size={13} className="inline-icon" aria-hidden />
        </a>
        {article.doi && (
          <a href={`https://doi.org/${article.doi}`} target="_blank" rel="noreferrer">
            DOI <ExternalLink size={13} className="inline-icon" aria-hidden />
          </a>
        )}
        {/* Pushed to the far end of the row: it's the card's one action, and
            grouping it with the links would read as a third destination. */}
        {bookmarking && (
          <span className="card-bookmark">
            <BookmarkMenu
              pmid={article.pmid}
              bookmarking={bookmarking}
              onError={onError}
              onNewFolder={onNewFolder}
            />
          </span>
        )}
      </div>
    </article>
  );
}
