import type { PaperProvenance } from "../types";

// Where a paper came from, when it wasn't acquired here.
//
// One component for two callers — the papers table and the article card — for
// the reason this file exists at all: the copy used to be a template literal
// duplicated in both, written for the organisation case and left unchanged when
// contributions from paired writers started arriving through the same field. A
// master's rows then read "bought by the organization, not here" about papers a
// freelancer had donated, which is not a wording slip but the opposite claim, on
// the one feature whose whole purpose is licensing accuracy.
//
// So the wording lives in exactly one place and is chosen by `kind` rather than
// assumed. Adding a case to PaperProvenance now fails to compile here until it
// has words of its own.

/**
 * A label, never a filter.
 *
 * Absent in a free build and on locally acquired papers, so it reads as an
 * exception rather than as a column everything carries. A search that hid
 * supplied papers would end in buying one again, which is the failure the whole
 * feature exists to stop.
 */
export function ProvenanceBadges({ entries }: { entries?: PaperProvenance[] }) {
  if (!entries || entries.length === 0) return null;
  return (
    <>
      {entries.map((entry, i) => (
        // Index as key: this list is built fresh per render from one row's
        // provenance, never reordered and never keyed on by anything else.
        <span
          key={i}
          className={entry.kind === "former-node" ? "from-org from-org-faded" : "from-org"}
          title={provenanceTitle(entry)}
        >
          {provenanceLabel(entry)}
        </span>
      ))}
    </>
  );
}

/** What the badge itself reads. */
function provenanceLabel(entry: PaperProvenance): string {
  // No name to show once a pairing has ended — the record keeps the node id,
  // but a name nobody at the agency recognises any more is clutter on every row
  // it touches. The badge still appears, because "supplied from someone else's
  // library" is the licensing fact and it outlives the connection.
  return entry.kind === "former-node" ? "contributed" : entry.label;
}

/**
 * The hover text, which is where the licensing story actually gets told.
 *
 * Each case says who supplied it *and* that it was not bought here — the second
 * half being the point. The org case says "not you" because that badge is read
 * on a writer's own machine; the contributor cases say "not bought here"
 * because they are read on the agency's.
 */
function provenanceTitle(entry: PaperProvenance): string {
  switch (entry.kind) {
    case "org":
      return `Copied from ${entry.label}'s library — bought by the organization, not you`;
    case "node":
      return `Contributed by ${entry.label} — copied from their library, not bought here`;
    case "former-node":
      return "Contributed by a writer whose pairing has ended — copied from their library, not bought here";
  }
}
