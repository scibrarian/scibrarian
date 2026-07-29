# Scibrarian

A self-hosted web app that watches the top medical journals you choose and keeps
a **per-topic feed** of the most recent research, pulled from PubMed/NCBI. Runs
on your laptop or on a server you control.

- Two workspaces: **Interests** (topics you follow) and **Library** (papers you
  already have), each with a picker for the topic or collection in view.
- Every workspace renders three ways — **Papers** (sortable table), **Timeline**
  (reverse-chronological), and **Graph** — switched from the header.
- You specify the journals and the topics in **Settings** (the gear icon in the
  header). Each topic is a MeSH heading, so PubMed is searched by that heading.
- **Check for new papers** polls on demand; optional scheduled polling (off by
  default) runs on a cron expression you set in Settings. A cron only fires while
  the process is up, so if a schedule was missed while it was down — a closed
  desktop app, a stopped container, a rebooted host — the next startup runs that
  poll a few seconds in. How long counts as "missed" comes from your own cron, so
  a weekly schedule stays weekly.
- Reference data (the NLM journal catalog, OpenAlex impact metrics, and the MeSH
  vocabulary) refreshes itself on startup and on a daily background check.
- Papers (title, authors, journal, date, abstract, PubMed/DOI link) are stored locally
  in SQLite, so the timeline persists.
- **Collections**: upload PDFs of papers you already have; they're matched against
  PubMed and stored locally in a content-addressed blob store.
- **Citation graph**: an interactive force-directed graph of any topic or collection,
  with citation counts from NIH iCite and automatic cluster detection.

## Requirements

- Node.js 22.13+ (CI runs the suite on 22; development happens on newer majors).
  Storage uses Node's built-in `node:sqlite` module, so there are no native
  dependencies to compile.
- To deploy rather than develop, you don't need Node at all — a published Docker
  image covers it. See [Deploying](#deploying).

## Setup

```bash
npm install        # installs root + server + client workspaces
npm run dev        # starts the API (http://localhost:3001) and the UI (http://localhost:5173)
```

Then open the UI URL printed by Vite (default http://localhost:5173).

1. Open **Settings** — the gear icon in the header.
2. Add the journals you want to watch (e.g. *New England Journal of Medicine*, *Lancet*,
   *JAMA*, *Nature Medicine*).
3. Add the topics you want to track. Each topic is a **MeSH heading** — search the
   vocabulary and pick one (typing a synonym like `type 2 diabetes` or `NIDDM` finds
   the official term `Diabetes Mellitus, Type 2`).
4. Click **Check for new papers**. Pick a topic from the workspace dropdown to see
   its papers, and switch between Papers / Timeline / Graph in the header.

## Tests

```bash
npm test           # runs the Vitest suite for both workspaces
```

Tests live next to the code they cover (`*.test.ts`) and focus on pure logic —
share-link signing, PubMed response parsing, PDF identifier matching, journal
ranking, formatting, and citation-graph clustering. `npx vitest` starts the
watcher during development. On every pull request CI runs the suite, typechecks
the server, and builds the client; on `master` it also publishes the Docker
image.

## Configuration

Two separate places, split by who owns the value:

- **App settings** live in the UI (gear icon) and are stored in the database:
  journals, topics, the polling schedule, an NCBI API key (higher rate limit),
  your contact email, and the sharing options. Nothing here belongs in a file.
- **Deploy settings** live in `server/.env` — copy `.env.example` to start.
  These cover `PORT`, `HOST`, `DB_PATH`, `BLOBS_DIR`, and `ADMIN_TOKEN`.
  Everything works without the file.

## Production build

```bash
npm run build      # builds the client
npm start          # serves the built UI + API from http://localhost:3001
```

## Desktop app

The same app also runs as a native window, with no browser and no URL to
remember:

```bash
npm run desktop    # builds the client + server bundle, then opens the app
```

It is the ordinary server running inside Electron, bound to `127.0.0.1` on an
OS-assigned port, so nothing is reachable from the network and no admin token is
involved. Sharing is therefore unavailable in the desktop build by design — to
share a library, run the server (see [Sharing your server](#sharing-your-server)).
Your database and PDFs live in the per-user app data directory
(`%APPDATA%\Scibrarian`, `~/Library/Application Support/Scibrarian`, or
`~/.config/Scibrarian`) rather than in `data/`.

To build installers — and for code signing, which is what stands between a build
and something other people can install — see **[DESKTOP.md](DESKTOP.md)**.

## Deploying

For running this on a server rather than your laptop, see **[DEPLOY.md](DEPLOY.md)**.
CI publishes a multi-arch image to `ghcr.io/scibrarian/scibrarian` on every green
`master` commit, so a host needs Docker and nothing else:

```bash
docker run -d --name scibrarian --restart unless-stopped --init \
  -p 127.0.0.1:3001:3001 \
  -e ADMIN_TOKEN='<generate one>' \
  -v scibrarian-data:/data \
  ghcr.io/scibrarian/scibrarian:latest
```

DEPLOY.md covers the two exposure models in full — a private tailnet
(recommended) or a public domain with HTTPS via the bundled Caddy compose file —
plus EC2 provisioning, backups, and updates.

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
   file, click the **share icon** next to the paper — it copies a signed link
   that works for 24 hours. The share icon beside the collection picker does
   the same for a whole collection, downloaded as a zip. (Links work for
   whoever has them, so send them privately; rotating `ADMIN_TOKEN` cancels
   all outstanding links.) If your instance already sits behind its own login
   (VPN, reverse-proxy auth), you can instead flip **Open Library** in
   Settings → Sharing to let viewers download stored PDFs directly. The
   exact address to send people (with a copy button) is shown in
   **Settings → Sharing** once you unlock admin mode.
3. To administer, click the **padlock** in the header and paste the token. The
   browser remembers it (localStorage) until you click the open padlock to
   leave admin mode. The server re-checks the token on every request.

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

## Contributing

Contributions are welcome. Because the project is offered under the terms
described in [License](#license) below, every contributor must agree to the
[Contributor License Agreement](CLA.md) before their code can be merged. This
is automated: the first time you open a pull request, a bot will ask you to
sign by leaving a one-line comment. You only sign once.

## License

Copyright © 2026 Anthony Salvato.

Scibrarian is free software, licensed under the **GNU Affero General Public
License, version 3 (AGPL-3.0-only)**. See the [LICENSE](LICENSE) file for the
full text. In short: you may use, study, share, and modify it, but if you run a
modified version to provide a network service, you must offer that service's
users the corresponding source code.

The project is also available under separate commercial terms. All
contributions are made under the [CLA](CLA.md), which lets the copyright holder
offer the project under both the AGPL and other license terms. If you would
like a commercial license, contact the maintainer.
