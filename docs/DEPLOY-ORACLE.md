# Deploying GhostPatch on Oracle Cloud — Always Free tier

Oracle's **Always Free** tier is the only 2026 free hosting option with enough
disk, CPU and RAM for 500 MB video patching. What you get, forever, at $0:

| Resource | Always Free allowance |
|---|---|
| ARM compute (VM.Standard.A1.Flex) | **2 OCPU + 12 GB RAM total** (halved from 4/24 in June 2026) |
| x86 compute (VM.Standard.E2.1.Micro) | 2 tiny VMs (1 GB RAM each — too weak for this app) |
| Block storage | **200 GB total** |
| Outbound traffic | **10 TB / month** |

GhostPatch needs roughly: 1 process (Next.js standalone), ffmpeg binary,
~2.2 × video size of transient disk, ≥1 GB RAM. The A1 shape covers all of it
with room to spare.

> **App design note:** GhostPatch is restart-tolerant by design. Job videos are
> ephemeral (2h TTL, auto-janitored) and only the tiny stats counter lives in
> SQLite (kept in a docker volume). If the VM ever reboots, the site keeps
> working.

---

## Step 0 — Create the account (the hardest part)

1. Go to **https://cloud.oracle.com** → *Start for free*.
2. You'll need a **credit/debit card for identity verification** — it is **not
   charged** on Always Free. (Prepaid/virtual cards sometimes fail; a normal
   bank card works best.)
3. **Choose your home region carefully — it can never be changed.** ARM (A1)
   capacity is scarce in popular regions (`us-ashburn-1`, `eu-frankfurt-1`,
   `uk-london-1`, `ap-mumbai-1`…). Quieter regions (`ap-hyderabad-1`,
   `ap-melbourne-1`, `ca-toronto-1`, `sa-saopaulo-1`, `me-dubai-1`,
   `eu-marseille-1`, `af-johannesburg-1`) are much easier. Pick a quiet one if
   you can tolerate the latency.
4. Choose the **"Always Free" / no-paid-services** path during signup if asked.

## Step 1 — Create the ARM instance

Console → ☰ menu → **Compute → Instances → Create instance**

| Setting | Value |
|---|---|
| Name | `ghostpatch` |
| Shape | **VM.Standard.A1.Flex** (Ampere) |
| OCPUs | **2** |
| Memory | **12 GB** |
| Image | **Canonical Ubuntu 24.04** (click *Change image* if it shows something else) |
| SSH key | **Generate key pair** → download BOTH the private (`.key`) and public (`.key.pub`) files. You will not be able to download them again. |
| Boot volume | change size to **100 GB** (still inside the 200 GB free allowance) |

Click **Create**. If you get *"Out of capacity"* — see Troubleshooting below.

Note the **Public IP** on the instance page once it's running.

## Step 2 — Open the firewall (Security List)

Console → ☰ → **Networking → Virtual Cloud Networks** → click your VCN →
**Security Lists** → **Default Security List** → **Add Ingress Rules**:

| Source | Protocol | Dest Port | Purpose |
|---|---|---|---|
| `0.0.0.0/0` | TCP | `22` | SSH (restrict *Source* to your own IP if you know it) |
| `0.0.0.0/0` | TCP | `80` | HTTP |
| `0.0.0.0/0` | TCP | `443` | HTTPS |

## Step 3 — First SSH login + instance-level firewall

```bash
chmod 400 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC_IP>
```

⚠ **Oracle gotcha:** Ubuntu images on OCI ship iptables rules that silently
drop your HTTP traffic even after Step 2. Fix once, then reboot-proof it:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## Step 4 — Install Docker + run GhostPatch

```bash
# Docker (official installer, ARM-ready)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# log out and back in (exit + ssh again) so the group applies

# Get the code (public repo)
git clone https://github.com/skyro777/Ghost-Patch.git
cd Ghost-Patch

# Build + run (first build ≈ 5–10 min on ARM)
docker compose up -d --build

# Watch it come up
docker compose logs -f
```

Verify from your laptop: `http://<PUBLIC_IP>:3000` → the GhostPatch UI.

## Step 5 — Serve on port 80/443 with automatic HTTPS

Simplest working setup: **Caddy** as a reverse proxy (it obtains + renews
Let's Encrypt certificates for you).

First you need a domain — a cheap one (~$2–10/yr) or any free subdomain
service. Create an **A record** pointing the domain at `<PUBLIC_IP>`.

> **Cloudflare note:** if you use Cloudflare DNS, set the record to
> **DNS only (grey cloud)**. GhostPatch's uploads/downloads are chunked small
> (8 MB up / 24 MB down) so the orange proxy would also work, but grey-cloud
> + Caddy TLS is the zero-surprise path.

Then on the VM:

```bash
docker run -d --name caddy --restart unless-stopped \
  --network host \
  -v /home/ubuntu/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy-data:/data \
  caddy:latest
```

`/home/ubuntu/Caddyfile`:

```
yourdomain.com {
    reverse_proxy 127.0.0.1:3000
    # big uploads + long patch jobs
    request_body {
        max_size 600MB
    }
}
```

Open `https://yourdomain.com` — done.

## Step 6 — Maintenance

```bash
cd ~/Ghost-Patch
git pull
docker compose up -d --build        # rebuild + restart (stats survive: named volume)

docker compose logs -f              # tail logs
docker exec -it ghostpatch sh       # shell inside the container
docker exec ghostpatch ffmpeg -version   # sanity-check the engine

# backup the stats db
docker run --rm -v ghostpatch-db:/db -v /home/ubuntu:/backup alpine \
  tar czf /backup/ghostpatch-db-$(date +%F).tgz -C /db .
```

Jobs self-clean after ~2h; with a 100 GB boot volume you'd need ~45 concurrent
500 MB jobs to fill the disk, and the app refuses (clean 507 error) long before
that.

## Troubleshooting

**"Out of host capacity" when creating the A1 instance**
The classic Oracle experience. Options, in order:
1. Retry — capacity frees up constantly. Click *Retry* / re-create over a day
   or two.
2. Try the other **availability domain** in your region.
3. Try a **smaller shape first** (1 OCPU / 6 GB) — you can edit it up to 2/12
   later when capacity allows. 1 OCPU runs GhostPatch fine, just patches slower.
4. Worst case: sign up a new account in a quieter home region (region is
   locked at signup).

**Site unreachable on port 80/443** — 99% it's the Step 3 iptables rules, or
you skipped a Security List ingress rule (Step 2).

**Instance disappeared / was stopped** — Oracle may reclaim **idle** Always
Free instances (roughly: 95th-percentile CPU under ~20% for 7 days straight).
Real traffic keeps you far above that. If it happens, just start it again in
the console; the docker container comes back with `restart: unless-stopped`.

**Want a bigger safety margin?** — the E2.1.Micro x86 freebies make fine
watchdogs/backup runners, but at 1 GB RAM don't use them for the app itself.

---

*Guide researched 2026-10-30 — Oracle's Always Free ARM allowance was halved
(4 OCPU/24 GB → 2 OCPU/12 GB) in June 2026 and remains the most generous
surviving free tier. If it ever disappears, Fly.io (~$3/mo) or Railway
(~$5/mo) are the cheapest drop-in replacements for this docker setup.*
