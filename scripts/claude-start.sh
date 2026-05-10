#!/bin/bash
# Claude Code MCP — quick start after SSH login.
# Starts the bridge + reloads Caddy config into both Caddy processes.

export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1001/bus"
export XDG_RUNTIME_DIR=/run/user/1001
CADDYFILE=/opt/project_identuslabel/Caddyfile

echo "=== Claude Code MCP Server ==="

# 1. Start the bridge (single persistent claude process, Streamable HTTP)
systemctl --user restart claude-remote.service
sleep 4

# 2. Push Caddyfile to BOTH root-owned Caddy processes (SO_REUSEPORT on :2019)
CONFIG=$(/usr/local/bin/caddy adapt --config "$CADDYFILE" 2>/dev/null)
OK=0
for i in $(seq 1 10); do
    echo "$CONFIG" | curl -sf -X POST http://localhost:2019/load \
        -H "Content-Type: application/json" -d @- -o /dev/null && OK=$((OK+1))
done
echo "✓ Caddy config reloaded ($OK/10)"

sleep 1

# 3. Verify
if curl -sf http://localhost:3030/health > /dev/null; then
    echo "✓ MCP bridge running on port 3030"
    echo ""
    echo "Register this URL in https://claude.ai/settings/connectors :"
    echo "  https://identuslabel.cz/mcp/sse"
else
    echo "✗ Bridge not responding — check logs:"
    tail -20 /tmp/claude-remote.log
fi

echo ""
echo "Live logs: tail -f /tmp/claude-remote.log"
