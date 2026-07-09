# SciLuminate

A local web app that watches the top medical journals you choose and keeps a
**per-disease timeline** of the most recent research, pulled from PubMed/NCBI.

- One tab per disease, reverse-chronological timeline of papers.
- You specify the journals and the diseases (with PubMed search terms) in **Settings**.
- A background scheduler polls daily; a **Refresh now** button polls on demand.
- Papers (title, authors, journal, date, abstract, PubMed/DOI link) are stored locally
  in SQLite, so the timeline persists.
- **Collections**: upload PDFs of papers you already have; they're matched against
  PubMed and stored locally in a content-addressed blob store.
- **Citation graph**: an interactive force-directed graph of any disease or collection,
  with citation counts from NIH iCite and automatic cluster detection.

## Requirements

- Node.js 22.13+ (built and tested on Node 24). Storage uses Node's built-in
  `node:sqlite` module, so there are no native dependencies to compile.

## Setup

```bash
npm install        # installs root + server + client workspaces
npm run dev        # starts the API (http://localhost:3001) and the UI (http://localhost:5173)
```

Then open the UI URL printed by Vite (default http://localhost:5173).

1. Go to the **Settings** tab.
2. Add the journals you want to watch (e.g. *New England Journal of Medicine*, *Lancet*,
   *JAMA*, *Nature Medicine*).
3. Add the diseases you want to track. The **PubMed term** can be a MeSH term like
   `"diabetes mellitus, type 2"[MeSH]` or plain keywords like `alzheimer disease`.
4. Click **Refresh now**. Each disease gets its own tab with a timeline.

## Optional config

Copy `.env.example` to `server/.env` to set an NCBI API key (higher rate limit),
contact email, or a custom database path. Everything works without it.

## Production build

```bash
npm run build      # builds the client
npm start          # serves the built UI + API from http://localhost:3001
```
