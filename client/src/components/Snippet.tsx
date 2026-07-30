import { Fragment } from "react";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../../../shared/types";

// A search excerpt from a stored PDF, with the matched terms marked.
//
// The server delimits matches with two control characters rather than HTML, so
// nothing here has to trust markup assembled from a PDF's contents — this splits
// on those sentinels and builds the elements itself. React escapes the text
// either way; the point is that there is no markup to escape in the first place.
//
// Odd segments are the matched runs (split on OPEN, then on CLOSE, alternates
// unmatched/matched), which holds even for a malformed string: an unpaired
// sentinel just yields a segment that renders as plain text.
export function Snippet({ text, className }: { text: string; className?: string }) {
  const parts = text.split(SNIPPET_OPEN).flatMap((chunk, i) => {
    if (i === 0) return [{ marked: false, text: chunk }];
    const [hit, ...rest] = chunk.split(SNIPPET_CLOSE);
    return [
      { marked: true, text: hit },
      { marked: false, text: rest.join(SNIPPET_CLOSE) },
    ];
  });
  return (
    <p className={className} title="Matched inside the PDF">
      {parts.map((p, i) =>
        p.text === "" ? null : p.marked ? (
          <mark key={i}>{p.text}</mark>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        )
      )}
    </p>
  );
}
