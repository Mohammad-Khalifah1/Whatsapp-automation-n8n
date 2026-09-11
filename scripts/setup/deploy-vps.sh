#!/usr/bin/env bash
#
# Provision a fresh Ubuntu/Debian VPS for this project.
#
# Run it ON THE SERVER, as a user with sudo:
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/scripts/setup/deploy-vps.sh -o deploy.sh
#   less deploy.sh          # read it before running it
#   bash deploy.sh
#
# Or, after cloning the repo on the server:
#   bash scripts/setup/deploy-vps.sh
#
# It is idempotent — safe to re-run. It installs Docker, configures the
# firewall, hardens SSH, and checks DNS, but it does NOT start the stack:
# that needs a completed .env, which only you can write.
#
# See docs/DEPLOYMENT_HOSTINGER.md for the full walkthrough.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/whatsapp-support}"
STEP=0

say()  { STEP=$((STEP+1)); printf '\n\033[1m[%d] %s\033[0m\n' "$STEP" "$*"; }
ok()   { printf '    ok   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mFailed:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && die "Do not run as root. Use a sudo-capable user: Docker will run rootful anyway, but the app files should not be root-owned."
command -v sudo >/dev/null || die "sudo is required"

# ---------------------------------------------------------------------------
say "Checking the OS"
# ---------------------------------------------------------------------------
. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
case "${ID:-}" in
  ubuntu|debian) ok "$PRETTY_NAME" ;;
  *) warn "$PRETTY_NAME is untested; this script targets Ubuntu/Debian" ;;
esac

TOTAL_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
[ "$TOTAL_MB" -lt 1800 ] && warn "only ${TOTAL_MB}MB RAM — n8n wants 2GB+; consider a larger plan"
ok "${TOTAL_MB}MB RAM"

# ---------------------------------------------------------------------------
say "Updating packages"
# ---------------------------------------------------------------------------
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
sudo apt-get install -y -qq ca-certificates curl gnupg ufw fail2ban git
ok "base packages installed"

# ---------------------------------------------------------------------------
say "Installing Docker"
# ---------------------------------------------------------------------------
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  ok "already present: $(docker --version)"
else
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin
  ok "installed $(docker --version)"
fi

sudo systemctl enable --now docker >/dev/null 2>&1 || true
if ! groups "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  warn "added $USER to the docker group — log out and back in for it to apply"
fi

# ---------------------------------------------------------------------------
say "Configuring the firewall"
# ---------------------------------------------------------------------------
# Order matters: allow SSH BEFORE enabling, or you lock yourself out.
sudo ufw allow OpenSSH >/dev/null
sudo ufw allow 80/tcp comment 'HTTP - ACME challenge + redirect' >/dev/null
sudo ufw allow 443/tcp comment 'HTTPS' >/dev/null
sudo ufw --force enable >/dev/null
ok "ufw active: 22, 80, 443 only"
warn "port 5678 is deliberately NOT opened — n8n is reachable only through Caddy"

# Docker publishes ports by writing iptables rules that BYPASS ufw. The
# production compose file never publishes 5678, so this is belt-and-braces.
if [ ! -f /etc/docker/daemon.json ] || ! grep -q '"iptables"' /etc/docker/daemon.json 2>/dev/null; then
  warn "note: Docker port publishing bypasses ufw — never add a ports: mapping for n8n"
fi

# ---------------------------------------------------------------------------
say "Hardening SSH"
# ---------------------------------------------------------------------------
if [ -f /root/.ssh/authorized_keys ] || [ -f "$HOME/.ssh/authorized_keys" ]; then
  sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd 2>/dev/null || true
  ok "root login and password auth disabled (key auth only)"
else
  warn "no authorized_keys found — leaving password auth ON so you are not locked out"
  warn "add your SSH key, then re-run this script"
fi

sudo systemctl enable --now fail2ban >/dev/null 2>&1 || true
ok "fail2ban running"

# ---------------------------------------------------------------------------
say "Preparing the application directory"
# ---------------------------------------------------------------------------
sudo mkdir -p "$APP_DIR"
sudo chown "$USER:$USER" "$APP_DIR"
ok "$APP_DIR"

# ---------------------------------------------------------------------------
say "Checking DNS"
# ---------------------------------------------------------------------------
# Caddy cannot obtain a certificate until the domain resolves here, and
# repeated failures burn Let's Encrypt rate limits.
PUBLIC_IP=$(curl -4 -fsS --max-time 10 ifconfig.me 2>/dev/null || echo "")
if [ -n "${DOMAIN:-}" ]; then
  RESOLVED=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')
  if [ "$RESOLVED" = "$PUBLIC_IP" ]; then
    ok "$DOMAIN -> $PUBLIC_IP"
  else
    warn "$DOMAIN resolves to '${RESOLVED:-nothing}' but this server is $PUBLIC_IP"
    warn "fix the DNS A record and wait for propagation BEFORE starting the stack"
  fi
else
  ok "server public IP: ${PUBLIC_IP:-unknown}"
  warn "set DOMAIN=... before running this script to have DNS checked automatically"
fi

# ---------------------------------------------------------------------------
say "Done — remaining manual steps"
# ---------------------------------------------------------------------------
cat <<EOF

  1. Put the project in $APP_DIR (git clone, or scp it up).

  2. Create the environment file:
         cd $APP_DIR
         cp .env.prod.example .env
         nano .env

     Required before first start:
       DOMAIN               your hostname, DNS already pointing here
       ACME_EMAIL           a mailbox you actually read
       ADMIN_ALLOWED_IPS    your IP — run 'curl -4 ifconfig.me' from your laptop
       N8N_ENCRYPTION_KEY   openssl rand -hex 32   (back this up off-server)
       META_*, GOOGLE_SHEET_ID

  3. Start it:
         docker compose -f docker-compose.prod.yml up -d
         docker compose -f docker-compose.prod.yml logs -f caddy

     Watch for "certificate obtained successfully". If the ACME challenge
     fails, DNS or the firewall is wrong — fix it before retrying, because
     Let's Encrypt rate-limits repeated failures.

  4. Import and publish the workflows:
         node scripts/setup/import-workflows.js
         # then publish them from the editor

  5. Point Meta at:
         https://\${DOMAIN}/webhook/whatsapp/webhook

  6. Schedule backups:
         crontab -e
         0 3 * * * $APP_DIR/scripts/setup/backup.sh >> /var/log/wa-backup.log 2>&1

EOF
