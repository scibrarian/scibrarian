# Glossary

The domain's words as the code and the UI use them, for naming modules and
reading the code. Architecture words (module, interface, seam, adapter) are not
defined here.

**Holder**: what keeps a stored paper in the library. There are three: a topic
the paper is linked to (`article_topics`), a collection one of whose files is
matched to it (`collection_files.pmid`), and a bookmark folder that has it
bookmarked (`bookmarks`). A paper with no holder is deleted by the sweep. Not
holders: an imported entry's PMID (`bookmark_imports.pmid`, not yet a stored
paper), a checked-out copy (keyed by its blob, not its paper), and Pro's
organization and transfer tables. The module that owns letting go of a paper is
`server/src/holding.ts`.

**Sweep**: deleting every stored paper that has no holder
(`dropUnheldArticles`). It runs at startup, and after a removal that finds
nothing part way through storing a paper and attaching it to its holder.

**Scan**: the background job that reads a collection's pending PDFs and matches
each one to a paper.

**Lookup**: the background job that looks up a bookmark folder's pending
imported entries in PubMed and bookmarks the ones it finds.

**Transfer** (Pro): a stored PDF arriving from another library, either pushed
up by a paired node or pulled down from a master. Both land in
`storePulledFile`.

**Checked-out copy**: a stored PDF copied out under the paper's own name so the
machine's own viewer can open it, with any saves taken back into the library.
It is keyed by its blob, and it goes when no collection file names that blob any
longer.
