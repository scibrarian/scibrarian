# Deploying Scibrarian

Scibrarian is built for a **single owner on a trusted network**. Every *write*
(adding topics/journals, uploading PDFs, changing settings) requires an
`ADMIN_TOKEN`, but by design **every read is unauthenticated** — anyone who can
reach the port can view your topics, papers, abstracts, and graphs. Stored PDFs
are the exception: they're owner-only, or reachable via an expiring share link.

Pick the exposure model that matches who needs access.

Every option below runs the **published image**,
`ghcr.io/scibrarian/scibrarian`, so a server needs Docker and nothing else —
no source checkout, no toolchain, no build. Tags:

| Tag | Points at |
|-----|-----------|
| `latest` | the newest commit on `master` |
| `0.5.0` | the current release — re-pushed as fixes land within that version |
| `sha-<commit>` | one exact build; never moves, so it's what you pin or roll back to |

CI builds and pushes these on every green `master` commit (`linux/amd64` and
`linux/arm64`).

> **One-time, after the first publish:** GHCR packages start **private**. Open
> the package on GitHub → *Package settings* → *Change visibility* → **Public**,
> or every server will need `docker login ghcr.io` with a
> `read:packages` token before it can pull.

---

## Option A — Private network (recommended default)

Keep it off the public internet and reach it over a private mesh. Nothing to
brute-force, and you get HTTPS with no domain or certificates to manage.

1. Run the app on your server, published on the loopback only:
   ```bash
   openssl rand -hex 32                  # save this — it's your ADMIN_TOKEN
   docker run -d --name scibrarian --restart unless-stopped --init \
     -p 127.0.0.1:3001:3001 \
     -e ADMIN_TOKEN='<the token you just generated>' \
     -v scibrarian-data:/data \
     ghcr.io/scibrarian/scibrarian:latest
   ```
   From a source checkout, `docker compose up -d --build` does the same thing
   with a locally built image.
2. Install [Tailscale](https://tailscale.com/) on the server and your devices,
   then expose it inside your tailnet with HTTPS:
   ```bash
   sudo tailscale serve --bg 3001
   ```
   You'll get a `https://<host>.<tailnet>.ts.net` URL that only your devices can
   reach.

To share a specific PDF or collection with an outsider, use the app's built-in
**share links** (per file, or a whole collection as a zip) instead of opening
the instance. Rotating `ADMIN_TOKEN` invalidates all outstanding links.

---

## Option B — Public domain with HTTPS (`docker-compose.prod.yml`)

For when viewers can't install a VPN client. Caddy terminates TLS with automatic
Let's Encrypt certificates and reverse-proxies to the app; the app port is never
published to the host. An HTTP basic-auth login sits in front of the whole site
so the public read surface isn't wide open.

### Prerequisites
- A server with a **public IP** (a cloud VPS is the easy path).
- **Ports 80 and 443** open to the internet (Caddy needs 80 for the ACME
  challenge and the HTTP→HTTPS redirect).
- Docker + the Docker Compose plugin installed. That's the whole toolchain —
  the app image is pulled, not built here.
- A **domain you control** (or a free subdomain — see notes below).

### 1. Point DNS at the server
Create an `A` record for your chosen hostname pointing at the server's public
IPv4 (and an `AAAA` for IPv6 if you have one):
```
A    scibrarian.example.com   →   203.0.113.10
```
Wait for it to resolve (`dig +short scibrarian.example.com`) before continuing —
Caddy can't get a certificate until the name points here.

### 2. Fetch the three deployment files
No clone needed — the stack is one compose file plus two config templates:
```bash
mkdir -p ~/scibrarian && cd ~/scibrarian
base=https://raw.githubusercontent.com/scibrarian/scibrarian/master
curl -fsSLO "$base/docker-compose.prod.yml"
curl -fsSL "$base/.env.prod.example" -o .env
curl -fsSL "$base/Caddyfile.example" -o Caddyfile
```

### 3. Configure secrets and domain
Edit `.env`:
```ini
ADMIN_TOKEN=<paste `openssl rand -hex 32`>
DOMAIN=scibrarian.example.com
ACME_EMAIL=you@example.com
#SCIBRARIAN_TAG=0.5.0     # uncomment to pin a release instead of `latest`
```

### 4. Set the edge password
```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'your-password'
# Paste the printed $2a$… hash into the basic_auth block in Caddyfile,
# and set the username.
```
> The hash goes in the Caddyfile, **not** `.env`: docker-compose mangles the
> `$` characters in a bcrypt hash. If you'd rather run a public read-only
> dashboard (and let the app's share links reach outsiders), delete the
> `basic_auth` block instead.

### 5. Launch
```bash
docker compose -f docker-compose.prod.yml up -d
```
Visit `https://scibrarian.example.com`. You'll get the basic-auth prompt, then
unlock writes with your `ADMIN_TOKEN` (padlock in the header).

Watch the first cert issuance if anything looks off:
```bash
docker compose -f docker-compose.prod.yml logs -f caddy
```

### No domain? Behind NAT/CGNAT?
- **No domain:** a free dynamic-DNS name (e.g. DuckDNS `you.duckdns.org`) works
  as `DOMAIN` exactly the same way.
- **Home server behind a router:** forward ports 80/443 to the box, and use
  dynamic DNS since home IPs rotate.
- **Behind CGNAT (no real public IP):** you can't port-forward — use a tunnel
  (Cloudflare Tunnel or `tailscale funnel`) instead of this domain setup.

---

## Running on AWS EC2 (Ubuntu)

Concrete provisioning for **Option B** on AWS — from a blank instance to a live
`docker compose ... up`.

### 1. Launch the instance
- **AMI:** Ubuntu Server 24.04 LTS (or 22.04 LTS).
- **Type:** `t3.micro` (1 GB RAM) is enough — nothing is compiled on the box, so
  the old build-memory ceiling is gone. `t4g.micro` (Graviton/arm64) works too;
  the image is published for both architectures.
- **Storage:** 20 GB gp3 gives comfortable headroom for images and uploaded PDFs.

### 2. Security group (inbound rules)
| Type       | Port | Source            | Why                                          |
|------------|------|-------------------|----------------------------------------------|
| SSH        | 22   | My IP             | admin access                                 |
| HTTP       | 80   | 0.0.0.0/0, ::/0   | Let's Encrypt challenge + HTTP→HTTPS redirect |
| HTTPS      | 443  | 0.0.0.0/0, ::/0   | serving the site                             |
| Custom UDP | 443  | 0.0.0.0/0, ::/0   | HTTP/3 (optional)                            |

Leave **outbound** as the default (allow all) — the app reaches PubMed / NLM /
OpenAlex over HTTPS. Do **not** open 3001; the app port is never published to the
host. Forgetting 80/443 here is the most common reason the certificate never
issues.

### 3. Elastic IP + DNS
A plain EC2 public IP changes on every stop/start, so allocate an **Elastic IP**
and associate it with the instance. Point your DNS `A` record at that Elastic IP
and confirm it resolves before launching Caddy (Let's Encrypt rate-limits failed
attempts):
```bash
dig +short scibrarian.example.com   # must print your Elastic IP
```

### 4. Install Docker + the Compose plugin
SSH in (`ssh ubuntu@<elastic-ip>`), then install from Docker's official repo:
```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Run docker without sudo:
sudo usermod -aG docker $USER
```
Log out and back in (so the group takes effect), then verify: `docker compose version`.

### 5. Deploy
Follow **Option B, steps 2–5** above: fetch the three files, fill in `.env` and
`Caddyfile`, then `docker compose -f docker-compose.prod.yml up -d`. Watch the
first cert issuance with
`docker compose -f docker-compose.prod.yml logs -f caddy`.

> **Tip:** while shaking out DNS / security-group issues, point Caddy at the
> Let's Encrypt *staging* CA to avoid rate limits — add
> `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` inside the
> Caddyfile site block. Your browser will warn about an untrusted cert; once it
> works, remove that line and restart for the real one.

---

## Operations

**Data** lives in two Docker volumes — back these up:
- `scibrarian-data` — the SQLite database and uploaded PDF blobs.
- `caddy-data` — TLS certificates and the ACME account (prod only).

Compose prefixes its volumes with the project name, so under Option B the app
volume is `scibrarian_scibrarian-data`; the Option A `docker run` creates it
unprefixed as `scibrarian-data`. `docker volume ls` settles it. Example backup:
```bash
docker run --rm -v scibrarian_scibrarian-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/scibrarian-backup.tar.gz -C /data .
```

**Update** to the latest published image:
```bash
docker compose -f docker-compose.prod.yml up -d   # re-pulls; see pull_policy
docker image prune -f                             # drop the superseded image
```
If you pinned `SCIBRARIAN_TAG` to a `sha-…` build, change it in `.env` first —
otherwise you'll keep re-pulling the same image. To roll back, set
`SCIBRARIAN_TAG` to the previous `sha-…` and run the same command; the data
volume is untouched either way.

**NCBI email / API key** are configured in the app's Settings UI (gear icon),
not in any env file.
