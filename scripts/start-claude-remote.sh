#!/bin/bash
# Claude Code MCP Bridge — single persistent process, Streamable HTTP interface
# Logs: /tmp/claude-remote.log

LOG=/tmp/claude-remote.log
WORKDIR=/opt/project_identuslabel

echo "[$(date)] Starting MCP bridge on port 3030..." | tee -a "$LOG"
cd "$WORKDIR" || exit 1

exec node /opt/project_identuslabel/scripts/mcp-server.js 2>&1 | tee -a "$LOG"
