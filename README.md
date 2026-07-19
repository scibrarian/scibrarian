# SciLuminate

A local web app that watches the top medical journals you choose and keeps a
**per-topic timeline** of the most recent research, pulled from PubMed/NCBI.

- One tab per topic, reverse-chronological timeline of papers.
- You specify the journals and the topics (with PubMed search terms) in **Settings**.
- A background scheduler polls daily; a **Refresh now** button polls on demand.
- Papers (title, authors, journal, date, abstract, PubMed/DOI link) are stored locally
  in SQLite, so the timeline persists.
- **Collections**: upload PDFs of papers you already have; they're matched against
  PubMed and stored locally in a content-addressed blob store.
- **Citation graph**: an interactive force-directed graph of any topic or collection,
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
3. Add the topics you want to track. Each topic is a **MeSH heading** — search the
   vocabulary and pick one (typing a synonym like `type 2 diabetes` or `NIDDM` finds
   the official term `Diabetes Mellitus, Type 2`).
4. Click **Refresh now**. Each topic gets its own tab with a timeline.

## Tests

```bash
npm test           # runs the Vitest suite for both workspaces
```

Tests live next to the code they cover (`*.test.ts`) and focus on pure logic —
share-link signing, PDF identifier matching, formatting, and citation-graph
clustering. `npx vitest` starts the watcher during development.

## Optional config

Copy `.env.example` to `server/.env` to set an NCBI API key (higher rate limit),
contact email, a custom database path, or the sharing options below
(`HOST`, `ADMIN_TOKEN`). Everything works without it.

## Production build

```bash
npm run build      # builds the client
npm start          # serves the built UI + API from http://localhost:3001
```

## Sharing your server

By default the server only listens on this machine (`127.0.0.1`) and needs no
auth. To let other people browse your instance read-only:

1. Generate a token and set it in `server/.env`, along with the bind host:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   ```ini
   ADMIN_TOKEN=<the generated token>
   HOST=0.0.0.0        # or a specific LAN/Tailscale IP
   ```

2. Restart with `npm start`. Others browse to `http://<your-ip>:3001` and can
   view everything — papers, timelines, graphs — but every mutating control
   (Settings, refresh, uploads, add/delete) is hidden and the API rejects
   mutations without the token. Stored PDFs are the exception: uploaded full
   texts may be copyrighted, so they're owner-only. To hand a viewer one
   file, click the **🔗** next to the paper — it copies a signed link that
   works for 24 hours. The 🔗 beside the collection picker does the same for
   a whole collection, downloaded as a zip. (Links work for whoever has
   them, so send them privately; rotating `ADMIN_TOKEN` cancels all
   outstanding links.) If your instance already sits behind its own login
   (VPN, reverse-proxy auth), you can instead flip **Open Library** in
   Settings → Sharing to let viewers download stored PDFs directly. The
   exact address to send people (with a copy button) is shown in
   **Settings → Sharing** once you unlock admin mode.
3. To administer, click the **🔒 padlock** in the header and paste the token.
   The browser remembers it (localStorage) until you click **🔓** to leave
   admin mode. The server re-checks the token on every request.

The server refuses to start on a non-loopback `HOST` unless `ADMIN_TOKEN` is
set, so it can't be exposed writable-by-anyone by accident. With no
`ADMIN_TOKEN` (the default), nothing changes: loopback-only, no auth, no
padlock.

How you expose it matters:

- **Tailscale (recommended):** invite viewers to your tailnet and bind `HOST`
  to your Tailscale IP. Traffic is encrypted and nothing touches the public
  internet.
- **LAN:** `HOST=0.0.0.0` works, but plain HTTP means the token is visible to
  anyone sniffing the network — only unlock admin mode on networks you trust.
- **Public internet:** put the app behind a TLS reverse proxy (e.g. Caddy,
  nginx); never send the token over plain HTTP.
