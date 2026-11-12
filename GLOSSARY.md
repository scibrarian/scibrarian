# Glossary

The domain's words as the code and the UI use them, for naming modules and
reading the code. Architecture words (module, interface, seam, adapter) are not
defined here.

**Topic**: a set of MeSH headings a paper must carry all of, searched for in a
scope. Its name is unique, its headings are fixed when it is added, and no two
topics require the same headings. What a topic may be is
`server/src/topic-definition.ts`.

**Scope**: where a topic searches: all of PubMed, or a list of journals of its
own. Changing it takes out of the topic the papers the new scope doesn't cover;
a paper that then has no holder goes to the sweep.

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

**Reference file**: a reference manager's export, imported into a bookmark
folder: RIS, which EndNote, Zotero and Mendeley write, or PubMed's MEDLINE
format (.nbib). Read by `readReferenceFile` in `server/src/reference-file.ts`.

**Imported entry**: one journal article a reference file listed, a row in its
folder's `bookmark_imports`. It is listed as not yet a bookmark until the lookup
bookmarks it as the paper PubMed has for it, or the reader gives it a PMID or
removes it, and kept after that as settled. Known in its folder by a key: its
PMID, else its DOI, else its title, year, journal and first author. So an entry
imported again is the same entry, and one the reader dealt with stays dealt
with.

**Transfer** (Pro): a stored PDF arriving from another library, either pushed
up by a paired node or pulled down from a master. Both land in
`storePulledFile`.

**Checked-out copy**: a stored PDF copied out under the paper's own name so the
machine's own viewer can open it, with any saves taken back into the library.
It is keyed by its blob, and it goes when no collection file names that blob any
longer.

**Mail login**: the mail server and username a stored SMTP password was saved
with. The password is sent only to its own login: a save or a test email that
changes either has to bring its own password, and clearing the username clears
the password. Kept by `server/src/settings.ts`.
