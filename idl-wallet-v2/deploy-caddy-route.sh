#!/bin/bash
# Add the /wallet-v2 route to Caddy, proxying to IDL Wallet v2 on port 3004.
#
# MUST BE RUN AS ROOT — /root/Caddyfile is not readable or writable by the `identus` user.
#
#   sudo /opt/project_identuslabel/idl-wallet-v2/deploy-caddy-route.sh
#
# Idempotent: re-running detects an existing route and makes no changes.
# Modelled on presentation/deploy-caddy-route.sh.
#
# ── WHY PORT 3004 AND NOT 3003 ──────────────────────────────────────────────────────────────
# 3003 is already claimed in the Caddyfile by the `/test-wallet` staging route, even though
# nothing was listening on it. Running v2 there silently hijacked that route. 3004 is unclaimed
# by both the Caddyfile and any live listener.
#
# ── WHY `handle` AND NOT `handle_path` ──────────────────────────────────────────────────────
# `handle_path` strips the matched prefix; Next.js needs the /wallet-v2 prefix preserved because
# next.config.js sets basePath: '/wallet-v2'. This mirrors the existing /wallet route's comment.
#
# ── ORDERING ────────────────────────────────────────────────────────────────────────────────
# Inserted immediately BEFORE the `handle /wallet*` block. Caddy's `handle` directives are
# mutually exclusive and evaluated in source order, and `/wallet*` would otherwise also match
# `/wallet-v2/...` — so the more specific route must come first. (Same reasoning as the existing
# `@test_wallet` matcher's own comment.)

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: must run as root (needs /root/Caddyfile)." >&2
    exit 1
fi

CADDYFILE=/root/Caddyfile
BACKUP="/root/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"

cp "$CADDYFILE" "$BACKUP"
echo "Backed up $CADDYFILE -> $BACKUP"

python3 - <<'PYEOF'
path = "/root/Caddyfile"
with open(path) as f:
    content = f.read()

if "/wallet-v2*" in content:
    print("Route /wallet-v2* already present — no changes made.")
    raise SystemExit(0)

# Anchor: the existing v1 wallet block. We insert immediately before it so the more specific
# /wallet-v2 prefix is evaluated first.
anchor = """    # IDL Wallet (/wallet -> port 3002)"""

block = """    # IDL Wallet v2 (/wallet-v2 -> port 3004)
    # SDK v8 successor to v1. MUST precede /wallet* — that prefix would also match /wallet-v2/...
    # Note: 'handle' not 'handle_path', to preserve the prefix for Next.js basePath: '/wallet-v2'
    # Source: /opt/project_identuslabel/idl-wallet-v2
    handle /wallet-v2* {
        reverse_proxy 127.0.0.1:3004 {
            header_up Host {host}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
            # WebSocket support for Next.js
            header_up Connection {>Connection}
            header_up Upgrade {>Upgrade}
        }
    }

"""

if anchor not in content:
    raise SystemExit("Anchor '# IDL Wallet (/wallet -> port 3002)' not found — aborting, no changes made.")

content = content.replace(anchor, block + anchor, 1)
with open(path, "w") as f:
    f.write(content)
print("Inserted /wallet-v2 route before the /wallet route.")
PYEOF

echo "Validating and reloading Caddy (runs inside the identus-cloud-agent-proxy container)..."
if ! DOCKER_API_VERSION=1.44 docker exec identus-cloud-agent-proxy \
        caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    echo "ERROR: Caddyfile failed validation. Restoring $BACKUP and leaving Caddy untouched." >&2
    cp "$BACKUP" "$CADDYFILE"
    exit 1
fi

DOCKER_API_VERSION=1.44 docker exec identus-cloud-agent-proxy \
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

echo
echo "Verifying both wallets through the public endpoint:"
printf "  %-42s %s\n" "https://identuslabel.cz/wallet-v2" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://identuslabel.cz/wallet-v2)"
printf "  %-42s %s\n" "https://identuslabel.cz/wallet (v1)" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://identuslabel.cz/wallet)"
echo
echo "Both should read 200. If /wallet regressed, restore: cp $BACKUP $CADDYFILE && \\"
echo "  DOCKER_API_VERSION=1.44 docker exec identus-cloud-agent-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile"
