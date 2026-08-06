#!/bin/bash
set -euo pipefail

cp /root/Caddyfile "/root/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"

python3 - <<'PYEOF'
path = "/root/Caddyfile"
with open(path) as f:
    content = f.read()

anchor = """    handle_path /schemas* {
        root * /var/www/schemas
        file_server
    }
"""

block = """
    # Presentation deck (/presentation -> port 3040)
    # Static file server for the IDL Wallet / DID+VC explainer deck
    # Source file: /opt/project_identuslabel/presentation/index.html
    handle_path /presentation* {
        reverse_proxy 127.0.0.1:3040 {
            header_up Host {host}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
        }
    }
"""

if "/presentation*" in content:
    print("Route already present, skipping insert.")
else:
    if anchor not in content:
        raise SystemExit("Anchor block not found in /root/Caddyfile — aborting, no changes made.")
    content = content.replace(anchor, anchor + block, 1)
    with open(path, "w") as f:
        f.write(content)
    print("Inserted /presentation route into /root/Caddyfile.")
PYEOF

docker exec identus-cloud-agent-proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

sleep 1
echo "--- verification ---"
curl -sI https://identuslabel.cz/presentation | head -5
