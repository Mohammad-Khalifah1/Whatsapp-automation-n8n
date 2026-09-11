#!/usr/bin/env bash
#
# Watch for REAL WhatsApp traffic arriving from Meta.
#
# The point of this script is to tell apart three things that look identical
# in a normal log tail:
#
#   [SIMULATED]  a request from this machine — a test, not proof of anything
#   [META]       a request from a Facebook IP range — the real thing
#   [OTHER]      something else entirely, worth a look
#
# Every "success" recorded so far in this project came from simulated traffic.
# Only a [META] POST line proves the WhatsApp integration actually delivers.
#
# Usage (from your laptop):
#   bash scripts/testing/watch-live.sh
#
# Then send a WhatsApp message to the Meta test number and watch.

set -uo pipefail

HOST="${SERVER:-root@72.61.181.1}"
KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
LOG="${NGINX_LOG:-/var/log/nginx/access.log}"

# Meta/Facebook published egress ranges, first octets. Not exhaustive, but
# anything outside them that is not this machine gets flagged for inspection
# rather than silently assumed to be Meta.
META_RE='^(31\.13|157\.240|173\.252|69\.63|66\.220|69\.171|74\.119|102\.132|129\.134|147\.75|163\.114|179\.60|185\.60|204\.15|45\.64|103\.4)'

MY_IP="$(curl -4 -fsS --max-time 10 ifconfig.me 2>/dev/null || echo 'unknown')"

printf '\n  Watching %s for webhook traffic\n' "$HOST"
printf '  This machine is %s — its requests are SIMULATED, not proof.\n' "$MY_IP"
printf '  A [META] POST line is the only thing that proves real delivery.\n'
printf '  Ctrl-C to stop.\n\n'

# shellcheck disable=SC2029
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
  "tail -f -n 0 $LOG | grep --line-buffered 'webhook/whatsapp'" |
while IFS= read -r line; do
  ip="${line%% *}"
  method="$(printf '%s' "$line" | grep -oE '"(GET|POST)' | tr -d '"')"
  code="$(printf '%s' "$line" | grep -oE '" [0-9]{3} ' | tr -d '" ')"
  stamp="$(printf '%s' "$line" | grep -oE '\[[^]]+\]' | tr -d '[]')"

  if [ "$ip" = "$MY_IP" ]; then
    tag=$'\033[90m[SIMULATED]\033[0m'
  elif printf '%s' "$ip" | grep -qE "$META_RE"; then
    tag=$'\033[32m[META]\033[0m     '
  else
    tag=$'\033[33m[OTHER]\033[0m    '
  fi

  printf '  %s %-16s %-5s %s  %s\n' "$tag" "$ip" "${method:-?}" "${code:-???}" "${stamp:-}"

  if [ "$ip" != "$MY_IP" ] && printf '%s' "$ip" | grep -qE "$META_RE" && [ "$method" = "POST" ]; then
    case "$code" in
      200) printf '\n      \033[32mREAL MESSAGE ACCEPTED.\033[0m Check the Conversations tab.\n\n' ;;
      401) printf '\n      \033[31mRejected: signature invalid.\033[0m META_APP_SECRET does not match the app.\n\n' ;;
      500) printf '\n      \033[31mRejected: app secret not configured on the server.\033[0m\n\n' ;;
      *)   printf '\n      \033[33mUnexpected status %s.\033[0m\n\n' "$code" ;;
    esac
  fi
done
