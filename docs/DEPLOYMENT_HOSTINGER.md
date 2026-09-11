# Production Deployment (Hostinger VPS or similar)

**Nothing here has been executed.** This is the deployment plan, written so it
can be followed when you are ready. The MVP runs locally only.

---

## Target architecture

```
Internet
   │  HTTPS :443
   v
┌──────────────────────────────────────┐
│ VPS (Ubuntu 24.04 LTS)               │
│                                       │
│  ufw ── 22, 80, 443 only              │
│   │                                   │
│  Caddy (reverse proxy, auto-TLS)      │
│   ├── /webhook/whatsapp/*  → public   │
│   ├── /webhook/agent/send  → RESTRICTED│
│   └── /  (editor)          → RESTRICTED│
│   │                                   │
│  n8n :5678  (bound to 127.0.0.1)      │
│   │                                   │
│  Docker volume (n8n data)             │
└──────────────────────────────────────┘
   │
   v
Meta Cloud API · Google Sheets API
```

The critical property: **n8n is never directly reachable from the internet.**
Only Caddy is, and it exposes only the one path Meta needs.

---

## Costs

Honest numbers, no rounding down.

### Recurring

| Item | Cost | Notes |
|---|---|---|
| Hostinger VPS KVM 1 (1 vCPU, 4 GB) | **$6.49/mo** on a 24-month term | Comfortably enough for this workload |
| Domain | **$10–15/year** | ~$1/month |
| TLS (Let's Encrypt) | **$0** | Automated by Caddy |
| n8n Community | **$0** | Self-hosted |
| Google Sheets API | **$0** | Within quota |
| Meta Cloud API hosting | **$0** | Meta hosts it |
| **Total** | **≈ $7.50/month** | |

### WhatsApp messaging

| Category | Cost |
|---|---|
| **Service messages** (replies inside the 24h window) | **Free** since 1 Nov 2024 |
| Utility templates inside an open window | Free |
| Templates outside the window | **Paid**, varies by country |
| Marketing templates | **Paid** |

**For an inbound support desk that replies within 24 hours, messaging is free.**

### The costs people do not expect

1. **VPS renewal roughly doubles.** KVM 1 renews at about **$11.99/month** after
   the promotional term — a ~85% increase. Budget for it now rather than being
   surprised in two years.
2. **Late replies cost money.** Past the 24-hour window a free-form reply is
   impossible; only a billable template works. Slow response time converts a
   free conversation into a paid one. This is a real financial reason to watch
   the `UNANSWERED` queue.
3. **Backups may be an add-on.** Confirm whether automated backups are included
   in your plan or billed separately.
4. **Meta re-prices per market.** From 1 October 2026 additional countries move
   to standalone rate cards. Only relevant if you send templates.
5. **A dedicated phone number.** The number cannot already be on WhatsApp, so
   you may need a new SIM or a virtual number.
6. **Maintenance time.** Realistically about **an hour a month**: n8n updates,
   checking backups, and rotating credentials. Not a cash cost, but it is not
   zero.

### What would actually raise the bill

| Change | Impact |
|---|---|
| Above ~10 msg/min | Postgres needed → VPS KVM 2 (~$8.99 promo) |
| Marketing campaigns | Per-message template charges |
| Media storage | Object storage costs |
| Agent inbox | Possibly a second small service |

---

## Step 1 — Provision

Ubuntu 24.04 LTS, 1 vCPU / 4 GB minimum. Choose a region near your users
(Europe is a reasonable choice for Jordan).

```bash
ssh root@YOUR_VPS_IP
apt update && apt upgrade -y

# A non-root user
adduser deploy
usermod -aG sudo deploy

# Key-only SSH
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

Harden SSH in `/etc/ssh/sshd_config`:

```
PermitRootLogin no
PasswordAuthentication no
```

```bash
systemctl restart ssh
```

**Verify you can log in as `deploy` in a second terminal before closing this
one.** Locking yourself out of a fresh VPS is an avoidable afternoon.

---

## Step 2 — Firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status verbose
```

**Never open 5678.** n8n is reached only through the proxy.

---

## Step 3 — Docker

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
```

Log out and back in for the group to take effect.

---

## Step 4 — DNS

Point an A record at the VPS:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `wa` | `YOUR_VPS_IP` | 300 |

Giving `wa.yourdomain.com` its own subdomain keeps this system separate from
your website.

```bash
dig +short wa.yourdomain.com    # must return your VPS IP before continuing
```

TLS issuance fails if DNS has not propagated.

---

## Step 5 — Deploy

```bash
sudo mkdir -p /opt/whatsapp-support
sudo chown deploy:deploy /opt/whatsapp-support
cd /opt/whatsapp-support
git clone YOUR_REPO_URL .

cp .env.example .env
nano .env
```

Production `.env` differences:

```bash
N8N_HOST=wa.yourdomain.com
N8N_PROTOCOL=https
N8N_WEBHOOK_URL=https://wa.yourdomain.com/

# A NEW key — never reuse the development one
N8N_ENCRYPTION_KEY=<openssl rand -hex 32>

# Production Meta credentials
META_ACCESS_TOKEN=<system user token>
META_APP_SECRET=<production app secret>
WEBHOOK_VERIFY_TOKEN=<a new random value>

# Serialize assignment
N8N_CONCURRENCY_PRODUCTION_LIMIT=1

# Cap execution history (contains customer PII)
EXECUTIONS_DATA_MAX_AGE=168
EXECUTIONS_DATA_PRUNE=true
```

```bash
chmod 600 .env
```

### Bind n8n to localhost only

In `docker-compose.yml`, change the published port so it is unreachable from
outside:

```yaml
    ports:
      - "127.0.0.1:5678:5678"
```

This is the single most important production change. Without it, `ufw` is the
only thing standing between the internet and an unauthenticated n8n editor.

---

## Step 6 — Reverse proxy

Caddy is recommended over nginx here purely because it obtains and renews TLS
certificates automatically with no cron job to forget.

`/opt/whatsapp-support/Caddyfile`:

```caddy
wa.yourdomain.com {
    encode gzip

    # Meta's webhook — the ONLY genuinely public path.
    handle /webhook/whatsapp/* {
        reverse_proxy 127.0.0.1:5678
    }

    # The agent send endpoint can send messages as your business.
    # Restrict it to your office/VPN until the agent inbox has real auth.
    handle /webhook/agent/* {
        @allowed remote_ip 203.0.113.0/24
        handle @allowed {
            reverse_proxy 127.0.0.1:5678
        }
        respond 403
    }

    # Everything else, including the editor, is restricted.
    handle {
        @allowed remote_ip 203.0.113.0/24
        handle @allowed {
            reverse_proxy 127.0.0.1:5678
        }
        respond "Not found" 404
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        -Server
    }

    log {
        output file /var/log/caddy/whatsapp.log {
            roll_size 10MiB
            roll_keep 10
        }
    }
}
```

Replace `203.0.113.0/24` with your real office or VPN range. If you have no
static IP, use Caddy's `basic_auth` on the editor path instead — but never leave
it open.

Add to `docker-compose.yml`:

```yaml
  caddy:
    image: caddy:2-alpine
    container_name: caddy-whatsapp
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
      - caddy_logs:/var/log/caddy
    networks:
      - n8n_whatsapp_network
```

```bash
docker compose up -d
curl -I https://wa.yourdomain.com/webhook/whatsapp/webhook
```

---

## Step 7 — Configure

Same as local: publish the workflows, create the two credentials, set the error
workflow, set workflow 3's concurrency to 1.

Then update the Meta dashboard callback URL to:

```
https://wa.yourdomain.com/webhook/whatsapp/webhook
```

---

## Backups

**What must be backed up:**

1. The n8n Docker volume — workflows, credentials, execution history
2. **`N8N_ENCRYPTION_KEY`** — a volume backup without this key is useless,
   because every credential in it is undecryptable
3. The Google Sheet — Drive keeps versions, but export periodically anyway

`/opt/whatsapp-support/backup.sh`:

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR=/opt/backups
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"

# Stop briefly for a consistent SQLite snapshot.
cd /opt/whatsapp-support
docker compose stop n8n

docker run --rm \
  -v n8n_whatsapp_data:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/n8n-$STAMP.tar.gz" -C /data .

docker compose start n8n

# Keep 14 days.
find "$BACKUP_DIR" -name 'n8n-*.tar.gz' -mtime +14 -delete
echo "backup complete: n8n-$STAMP.tar.gz"
```

```bash
chmod +x backup.sh
crontab -e
# 0 3 * * * /opt/whatsapp-support/backup.sh >> /var/log/whatsapp-backup.log 2>&1
```

**Store `N8N_ENCRYPTION_KEY` somewhere else** — a password manager, not the same
server. And **test a restore**; an untested backup is a hypothesis.

Copy backups off the VPS (`rclone`, S3, or `scp` to another host). A backup that
only exists on the machine it protects does not protect it.

---

## Monitoring

### Health checks

```bash
*/5 * * * * curl -sf http://127.0.0.1:5678/healthz > /dev/null || echo "n8n down at $(date)" >> /var/log/n8n-health.log
```

For real alerting, point an external monitor (UptimeRobot's free tier is
sufficient) at a public path.

### What to watch

| Signal | Why | Where |
|---|---|---|
| `/healthz` | Service alive | HTTP check |
| Disk usage | Execution history grows | `df -h` |
| Failed executions | Silent breakage | n8n UI, Log sheet |
| `WAITING_FOR_AGENT` count | Staffing gaps | Conversations sheet |
| 401s in Caddy logs | Forged webhook attempts | Caddy log |
| Meta quality rating | Account health | WhatsApp Manager |

### Log rotation

`EXECUTIONS_DATA_MAX_AGE=168` (7 days) with pruning keeps the database bounded.
Execution data contains customer messages, so this is a privacy control as much
as a disk one.

---

## Updating

```bash
cd /opt/whatsapp-support
./backup.sh                              # always first

# Change the pinned tag in docker-compose.yml, then:
docker compose pull
docker compose up -d
docker compose logs -f n8n

curl -sf https://wa.yourdomain.com/webhook/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=ping
```

Keep the image pinned to an exact version. `:latest` means an unrelated
`docker compose up` can silently upgrade n8n and change behaviour.

After any n8n upgrade, re-verify node type versions —
[N8N_WORKFLOWS.md](N8N_WORKFLOWS.md#pinned-versions).

---

## Pre-launch checklist

- [ ] `ufw` enabled; 5678 not open
- [ ] n8n bound to `127.0.0.1`
- [ ] TLS working; HTTP redirects to HTTPS
- [ ] Editor and `/webhook/agent/*` restricted
- [ ] Fresh `N8N_ENCRYPTION_KEY`, backed up **off** the server
- [ ] `.env` is `chmod 600` and git-ignored
- [ ] System User token (not the 24-hour one)
- [ ] Workflows published; error workflow set
- [ ] Workflow 3 concurrency = 1
- [ ] Meta callback URL updated; handshake verified
- [ ] Backups scheduled **and a restore tested**
- [ ] Health check and external monitor running
- [ ] `EXECUTIONS_DATA_MAX_AGE` set
- [ ] `node scripts/validation/check-env.js` passes
- [ ] Sent and received a real test message end to end
