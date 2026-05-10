/**
 * MCP Bridge Server — dual protocol
 *
 * Supports BOTH transport protocols so claude.ai connectors work regardless
 * of which one the client uses:
 *
 *   Old SSE (GET /sse → stream + POST /message → messages back through stream)
 *   Streamable HTTP (POST /sse → request/response in same call)
 *
 * ONE persistent `claude mcp serve` child process shared by all sessions.
 * Listens on port 3030. Caddy routes /mcp/* → localhost:3030 (strips prefix).
 */

import http from 'http';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

function ipToInt(ip) {
    return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}
function isInCidr(ip, base, prefix) {
    try {
        const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
        return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
    } catch { return false; }
}

const PORT = 3030;
const CLAUDE_CMD = 'claude --dangerously-skip-permissions mcp serve';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
const API_KEY = process.env.MCP_API_KEY || '7d1176b36e04ec04709fc3cbc0683d606b420251c46af291d2016ec4cb3a1590';

// No CORS headers in the bridge — Caddy sets them to avoid duplicates
const CORS_HEADERS = {};

// ── Single persistent child process ─────────────────────────────────────────

let child = null;
let childBuffer = '';
const pending = new Map(); // unique-id → { resolve, reject }
let toolsCache = null;

function ensureChild() {
    if (child && !child.killed) return;
    console.log('[bridge] Spawning claude mcp serve...');
    child = spawn(CLAUDE_CMD, {
        shell: true,
        cwd: '/opt/project_identuslabel',
        env: { ...process.env, HOME: '/opt/project_identuslabel' },
    });
    child.on('exit', (code, signal) => {
        console.log(`[bridge] Child exited code=${code} signal=${signal}, restarting in 2s`);
        child = null;
        for (const cb of pending.values()) cb.reject(new Error('Child restarted'));
        pending.clear();
        setTimeout(() => { ensureChild(); autoInit(); }, 2000);
    });
    child.stderr.on('data', (c) => process.stderr.write('[claude] ' + c.toString()));
    child.stdout.on('data', (chunk) => {
        childBuffer += chunk.toString('utf8');
        const lines = childBuffer.split(/\r?\n/);
        childBuffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            console.log('[bridge] child→', JSON.stringify(msg).slice(0, 120));
            const id = String(msg.id);
            if (msg.id !== undefined && pending.has(id)) {
                const cb = pending.get(id);
                pending.delete(id);
                cb.resolve(msg);
            }
        }
    });
}

function sendToChild(msg) {
    return new Promise((resolve, reject) => {
        const id = String(msg.id);
        let done = false;
        const timer = setTimeout(() => {
            if (!done) { done = true; pending.delete(id); reject(new Error(`Timeout id=${id}`)); }
        }, 60000);
        pending.set(id, {
            resolve: (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
            reject:  (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
        });
        console.log('[bridge] →child', JSON.stringify(msg).slice(0, 120));
        child.stdin.write(JSON.stringify(msg) + '\n');
    });
}

async function autoInit() {
    try {
        await sendToChild({
            jsonrpc: '2.0', id: '__init__', method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: { roots: { listChanged: true }, sampling: {} },
                clientInfo: { name: 'bridge', version: '1.0' },
            },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        console.log('[bridge] Child ready');
        const t = await sendToChild({ jsonrpc: '2.0', id: '__tools__', method: 'tools/list', params: {} });
        if (t?.result) {
            // Strip non-standard MCP fields — keep only name, description, inputSchema
            // Also remove $schema from inputSchema (claude.ai rejects JSON Schema 2020-12 dialect)
            const cleaned = (t.result.tools ?? []).map(({ name, description, inputSchema }) => {
                if (inputSchema) {
                    const { $schema, ...schemaRest } = inputSchema;
                    inputSchema = schemaRest;
                }
                // Truncate long descriptions — claude.ai has response size limits
                const shortDesc = description ? description.split('\n')[0].slice(0, 200) : undefined;
                return {
                    name,
                    ...(shortDesc !== undefined ? { description: shortDesc } : {}),
                    ...(inputSchema !== undefined ? { inputSchema } : {}),
                };
            });
            toolsCache = { tools: cleaned };
            console.log('[bridge] Cached', cleaned.length, 'tools (cleaned)');
        }
    } catch (e) { console.error('[bridge] autoInit error:', e.message); }
}

// ── Sessions ─────────────────────────────────────────────────────────────────

// Streamable HTTP sessions: id → { expiry, sseRes? }
// sseRes is set when client has an active GET /sse channel open
const streamableSessions = new Map();

// Old SSE sessions: id → { res (SSE response), expiry }
const sseSessions = new Map();

function touchStreamable(id) {
    const s = streamableSessions.get(id) ?? {};
    streamableSessions.set(id, { ...s, expiry: Date.now() + SESSION_TTL_MS });
}
function validStreamable(id) {
    const s = streamableSessions.get(id);
    if (!s) return false;
    if (Date.now() > s.expiry) { streamableSessions.delete(id); return false; }
    return true;
}
function setSseChannel(id, res) {
    const s = streamableSessions.get(id) ?? { expiry: Date.now() + SESSION_TTL_MS };
    streamableSessions.set(id, { ...s, sseRes: res });
}
function getSseChannel(id) {
    const s = streamableSessions.get(id);
    if (!s?.sseRes || s.sseRes.writableEnded) return null;
    return s.sseRes;
}

setInterval(() => {
    const now = Date.now();
    for (const [id, exp] of streamableSessions) if (now > exp) { streamableSessions.delete(id); }
    for (const [id, s] of sseSessions) if (now > s.expiry) { sseSessions.delete(id); }
}, 5 * 60 * 1000);

// ── Shared MCP request handler ────────────────────────────────────────────────
// Processes a JSON-RPC message and returns the result to send back.

async function handleMcpMessage(body) {
    ensureChild();

    if (body.method === 'initialize') {
        return {
            jsonrpc: '2.0', id: body.id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'claude-bridge', version: '1.0' },
            },
        };
    }

    if (!body.id) return null; // notification — no response needed

    if (body.method === 'ping') {
        return { jsonrpc: '2.0', id: body.id, result: {} };
    }

    if (body.method === 'tools/list' && toolsCache) {
        const EXPOSED = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
        const tools = toolsCache.tools.filter(t => EXPOSED.has(t.name));
        return { jsonrpc: '2.0', id: body.id, result: { tools } };
    }

    const childId = randomUUID();
    const result = await sendToChild({ ...body, id: childId });
    return { ...result, id: body.id };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function readBody(req) {
    if (req.body_cached !== undefined) {
        try { return Promise.resolve(JSON.parse(req.body_cached)); } catch { return Promise.resolve(null); }
    }
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => { data += c; });
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        req.on('error', reject);
    });
}

function writeSseEvent(res, msg) {
    res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
}

// For Streamable HTTP: single responses use application/json per MCP 2025-11-25 spec
function sendMcpResponse(res, msg, sessionId, protoVersion) {
    const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (protoVersion) headers['mcp-protocol-version'] = protoVersion;
    res.writeHead(200, headers);
    res.end(JSON.stringify(msg));
}

// Legacy SSE wrapper (kept for old SSE protocol push)
function sendSseResponse(res, msg, sessionId, protoVersion) {
    const headers = { ...CORS_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (protoVersion) headers['mcp-protocol-version'] = protoVersion;
    res.writeHead(200, headers);
    writeSseEvent(res, msg);
    res.end();
}

function sendJson(res, status, body) {
    res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

// ── Main server ───────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const sid = req.headers['mcp-session-id'] ?? '-';
    // Log method+body for POST requests
    if (req.method === 'POST') {
        const raw = await new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(d)); });
        let method = '?';
        try { method = JSON.parse(raw).method ?? '?'; } catch {}
        console.log(`[bridge] POST ${req.url} session=${sid} method=${method}`);
        // Re-inject body for downstream handlers
        req.body_cached = raw;
    } else {
        console.log(`[bridge] ${req.method} ${req.url} session=${sid}`);
    }

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }
    if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }

    // API key authentication — skip for Anthropic's cloud IPs (claude.ai connector)
    const clientIp = (req.headers['x-real-ip'] || req.socket.remoteAddress || '').replace('::ffff:', '');
    const isAnthropicIp = isInCidr(clientIp, '160.79.104.0', 21);
    if (!isAnthropicIp) {
        const auth = req.headers['authorization'] ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (token !== API_KEY) {
            console.log(`[bridge] 401 from ${clientIp}`);
            res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="MCP"', 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
    }

    // GET /sse — two behaviours depending on whether a session ID is present
    if (req.method === 'GET' && (url.pathname === '/sse' || url.pathname === '/')) {
        const existingId = req.headers['mcp-session-id'];

        // ── Streamable HTTP GET: client has a session, wants a server-push channel ──
        if (existingId && validStreamable(existingId)) {
            touchStreamable(existingId);
            res.writeHead(200, {
                ...CORS_HEADERS,
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'mcp-session-id': existingId,
            });
            res.write(': connected\n\n');
            // Store this SSE channel so POST handlers can push responses through it
            setSseChannel(existingId, res);
            const ping = setInterval(() => {
                if (res.writableEnded) { clearInterval(ping); return; }
                res.write(': ping\n\n');
            }, 15000);
            req.on('close', () => { clearInterval(ping); console.log('[bridge] SSE push channel closed', existingId); });
            return;
        }

        // ── Old SSE protocol: no session → open new SSE stream, send endpoint URL ──
        const sessionId = randomUUID();
        res.writeHead(200, {
            ...CORS_HEADERS,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'mcp-session-id': sessionId,
        });
        res.write(`event: endpoint\ndata: https://identuslabel.cz/mcp/message?sessionId=${sessionId}\n\n`);

        sseSessions.set(sessionId, { res, expiry: Date.now() + SESSION_TTL_MS });
        const ping = setInterval(() => {
            if (res.writableEnded) { clearInterval(ping); return; }
            res.write(': ping\n\n');
        }, 15000);
        req.on('close', () => {
            clearInterval(ping);
            sseSessions.delete(sessionId);
            console.log('[bridge] SSE session closed', sessionId);
        });
        console.log('[bridge] SSE session opened', sessionId);
        return;
    }

    // POST /message?sessionId=xxx — old SSE protocol client→server messages
    if (req.method === 'POST' && url.pathname === '/message') {
        const sessionId = url.searchParams.get('sessionId');
        const session = sseSessions.get(sessionId);
        if (!session) { sendJson(res, 404, { error: 'Session not found' }); return; }

        const body = await readBody(req);
        if (!body) { sendJson(res, 400, { error: 'Invalid JSON' }); return; }

        res.writeHead(202, CORS_HEADERS); res.end();

        try {
            const result = await handleMcpMessage(body);
            if (result && !session.res.writableEnded) {
                writeSseEvent(session.res, result);
                // After initialize, send a keepalive so client knows to use this session
            }
        } catch (e) {
            if (!session.res.writableEnded) {
                writeSseEvent(session.res, {
                    jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: body.id ?? null,
                });
            }
        }
        return;
    }

    // ── STREAMABLE HTTP PROTOCOL ──────────────────────────────────────────────
    // POST /sse — streamable HTTP request/response
    if (req.method === 'POST' && (url.pathname === '/sse' || url.pathname === '/')) {
        const body = await readBody(req);
        if (!body) { sendJson(res, 400, { error: 'Invalid JSON' }); return; }

        const isInit = body.method === 'initialize';
        let sessionId = req.headers['mcp-session-id'];

        if (isInit) {
            sessionId = randomUUID();
            touchStreamable(sessionId);
            const clientProto = req.headers['mcp-protocol-version'] || body.params?.protocolVersion || '2024-11-05';
            const negotiated = clientProto; // echo client's version — server supports whatever client sends
            console.log(`[bridge] initialize: clientProto=${clientProto} negotiated=${negotiated} newSession=${sessionId}`);
            sendMcpResponse(res, {
                jsonrpc: '2.0', id: body.id,
                result: { protocolVersion: negotiated, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'claude-bridge', version: '1.0' } },
            }, sessionId, negotiated);
            return;
        }

        if (!sessionId || !validStreamable(sessionId)) {
            sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid or missing session ID' }, id: body.id ?? null });
            return;
        }
        touchStreamable(sessionId);

        if (!body.id) { res.writeHead(202, CORS_HEADERS); res.end(); return; }

        try {
            const result = await handleMcpMessage(body);
            const protoVersion = req.headers['mcp-protocol-version'];
            console.log(`[bridge] direct response: ${body.method} id=${body.id}`);
            sendMcpResponse(res, result, sessionId, protoVersion);
        } catch (e) {
            sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: body.id ?? null });
        }
        return;
    }

    // DELETE /sse — close streamable HTTP session
    if (req.method === 'DELETE' && (url.pathname === '/sse' || url.pathname === '/')) {
        const sessionId = req.headers['mcp-session-id'];
        if (sessionId) { streamableSessions.delete(sessionId); console.log('[bridge] Session deleted', sessionId); }
        res.writeHead(200, CORS_HEADERS); res.end();
        return;
    }

    sendJson(res, 404, { error: 'Not found' });

}).listen(PORT, '127.0.0.1', () => {
    console.log(`[bridge] MCP bridge listening on port ${PORT}`);
    ensureChild();
    autoInit();
});
