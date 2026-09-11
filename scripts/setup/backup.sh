#!/usr/bin/env bash
#
# Back up the n8n data volume and configuration.
#
# WHAT A USABLE BACKUP NEEDS
# --------------------------
# n8n encrypts stored credentials with N8N_ENCRYPTION_KEY. A backup of the
# volume WITHOUT that key cannot decrypt its own credentials, so restoring it
# means re-entering every credential by hand. This script therefore records
# whether the key is present and refuses to pretend a keyless backup is
# complete.
#
# Usage:
#   bash scripts/setup/backup.sh
#
# Cron (daily at 03:00):
#   0 3 * * * /opt/whatsapp-support/scripts/setup/backup.sh >> /var/log/wa-backup.log 2>&1

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/whatsapp-support}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
VOLUME="${N8N_VOLUME:-n8n_whatsapp_data}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/n8n-$STAMP.tar.gz"

log() { printf '%s  %s\n' "$(date -Is)" "$*"; }
die() { log "FAILED: $*"; exit 1; }

mkdir -p "$BACKUP_DIR"

# --- 1. Verify the volume exists before claiming to back anything up -------
docker volume inspect "$VOLUME" >/dev/null 2>&1 \
  || die "docker volume '$VOLUME' not found"

# --- 2. Archive the volume -------------------------------------------------
# A helper container mounts the volume read-only and streams a tarball out.
# n8n keeps running: SQLite in WAL mode tolerates being copied, and the worst
# case is losing the last few seconds of execution history — not workflows or
# credentials.
log "archiving volume '$VOLUME'"
docker run --rm \
  -v "$VOLUME":/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine:3 \
  tar czf "/backup/$(basename "$ARCHIVE")" -C /data . \
  || die "volume archive failed"

SIZE=$(du -h "$ARCHIVE" | cut -f1)
log "wrote $ARCHIVE ($SIZE)"

# --- 3. Verify the archive is actually readable ----------------------------
# An unverified backup is a guess. This catches truncation and disk-full.
tar tzf "$ARCHIVE" >/dev/null 2>&1 || die "archive is corrupt: $ARCHIVE"
if ! tar tzf "$ARCHIVE" 2>/dev/null | grep -q 'database.sqlite'; then
  die "archive does not contain database.sqlite — backed up the wrong volume?"
fi
log "archive verified (contains database.sqlite)"

# --- 4. Configuration, minus the secrets -----------------------------------
CONFIG_ARCHIVE="$BACKUP_DIR/config-$STAMP.tar.gz"
tar czf "$CONFIG_ARCHIVE" -C "$APP_DIR" \
  --exclude='.git' --exclude='node_modules' --exclude='.env' \
  docker-compose.prod.yml Caddyfile n8n scripts sheets-templates docs 2>/dev/null \
  || log "note: some config paths were missing (non-fatal)"
log "wrote $CONFIG_ARCHIVE"

# --- 5. The encryption key: the part people get wrong -----------------------
# .env is deliberately NOT included above — a backup archive containing live
# secrets, sitting next to the data it unlocks, is worse than no backup.
if [ -f "$APP_DIR/.env" ] && grep -q '^N8N_ENCRYPTION_KEY=.\+' "$APP_DIR/.env"; then
  log "N8N_ENCRYPTION_KEY is set in .env (NOT included in this backup, by design)"
  log "ACTION: confirm that key is stored in a password manager, off this server."
  log "        Without it, this backup cannot decrypt its own credentials."
else
  log "WARNING: no N8N_ENCRYPTION_KEY found in .env — a restore will lose all credentials"
fi

# --- 6. Prune old backups ---------------------------------------------------
DELETED=$(find "$BACKUP_DIR" -name 'n8n-*.tar.gz' -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
find "$BACKUP_DIR" -name 'config-*.tar.gz' -mtime "+$RETENTION_DAYS" -delete
[ "$DELETED" -gt 0 ] && log "pruned $DELETED backup(s) older than ${RETENTION_DAYS}d"

REMAINING=$(find "$BACKUP_DIR" -name 'n8n-*.tar.gz' | wc -l)
log "done — $REMAINING backup(s) retained in $BACKUP_DIR"

# --- 7. Off-server copy -----------------------------------------------------
# A backup on the same disk as the data protects against nothing but fat
# fingers. Uncomment and configure one of these.
#
# rclone copy "$ARCHIVE" remote:whatsapp-backups/   # needs: apt install rclone
# scp "$ARCHIVE" user@backup-host:/backups/
#
if [ -z "${BACKUP_REMOTE:-}" ]; then
  log "NOTE: backups are local only. Set BACKUP_REMOTE and enable an off-site copy above."
fi
