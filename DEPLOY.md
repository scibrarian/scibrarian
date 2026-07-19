# Deploying SciLuminate

SciLuminate is built for a **single owner on a trusted network**. Every *write*
(adding topics/journals, uploading PDFs, changing settings) requires an
`ADMIN_TOKEN`, but by design **every read is unauthenticated** — anyone who can
reach the port can view your topics, papers, abstracts, and graphs. Stored PDFs
are the exception: they're owner-only, or reachable via an expiring share link.

Pick the exposure model that matches who needs access.

---

## Option A — Private network (recommended default)

Keep it off the public internet and reach it over a private mesh. Nothing to
brute-force, and you get HTTPS with no domain or certificates to manage.

1. Run the plain local stack on your server:
   ```bash
   printf 'ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
   docker compose up --build -d      # publishes 127.0.0.1:3001 only
   ```
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
- Docker + the Docker Compose plugin installed.
- A **domain you control** (or a free subdomain — see notes below).

### 1. Point DNS at the server
Create an `A` record for your chosen hostname pointing at the server's public
IPv4 (and an `AAAA` for IPv6 if you have one):
```
A    sciluminate.example.com   →   203.0.113.10
```
Wait for it to resolve (`dig +short sciluminate.example.com`) before continuing —
Caddy can't get a certificate until the name points here.

### 2. Configure secrets and domain
```bash
cp .env.prod.example .env
# Edit .env:
#   ADMIN_TOKEN=<paste `openssl rand -hex 32`>
#   DOMAIN=sciluminate.example.com
#   ACME_EMAIL=you@example.com
```

### 3. Set the edge password
```bash
cp Caddyfile.example Caddyfile
docker run --rm caddy:2 caddy hash-password --plaintext 'your-password'
# Paste the printed $2a$… hash into the basic_auth block in Caddyfile,
# and set the username.
```
> The hash goes in the Caddyfile, **not** `.env`: docker-compose mangles the
> `$` characters in a bcrypt hash. If you'd rather run a public read-only
> dashboard (and let the app's share links reach outsiders), delete the
> `basic_auth` block instead.

### 4. Launch
```bash
docker compose -f docker-compose.prod.yml up -d --build
```
Visit `https://sciluminate.example.com`. You'll get the basic-auth prompt, then
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
- **Type:** at least `t3.small` (2 GB RAM). The client is built on the box, and a
  1 GB `t3.micro` can run out of memory mid-build — use a micro only if you add
  swap (step 5).
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
dig +short sciluminate.example.com   # must print your Elastic IP
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

### 5. (Micro instances only) add swap
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 6. Deploy
```bash
git clone <your-repo-url> sciluminate && cd sciluminate
```
Now follow **Option B, steps 2–4** above: create `.env` and `Caddyfile`, then
`docker compose -f docker-compose.prod.yml up -d --build`. Watch the first cert
issuance with `docker compose -f docker-compose.prod.yml logs -f caddy`.

> **Tip:** while shaking out DNS / security-group issues, point Caddy at the
> Let's Encrypt *staging* CA to avoid rate limits — add
> `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` inside the
> Caddyfile site block. Your browser will warn about an untrusted cert; once it
> works, remove that line and restart for the real one.

---

## Operations

**Data** lives in two Docker volumes — back these up:
- `sciluminate-data` — the SQLite database and uploaded PDF blobs.
- `caddy-data` — TLS certificates and the ACME account (prod only).

Example backup of the app data:
```bash
docker run --rm -v sciluminate_sciluminate-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/sciluminate-backup.tar.gz -C /data .
```

**Update** to the latest code:
```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

**NCBI email / API key** are configured in the app's Settings UI (gear icon),
not in any env file.
