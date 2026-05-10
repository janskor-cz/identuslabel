// Thin HTTP proxy between Caddy and supergateway.
// Forces Accept: application/json, text/event-stream on all requests
// so supergateway's MCP SDK transport doesn't reject them with 406.
//
// Listens: port 3031
// Upstream: localhost:3030 (supergateway streamableHttp)

import http from 'http';

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 3030;
const LISTEN_PORT = 3031;

const server = http.createServer((req, res) => {
    // Override Accept header to satisfy MCP SDK's strict requirement
    const headers = { ...req.headers };
    headers['accept'] = 'application/json, text/event-stream';

    const options = {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: req.url,
        method: req.method,
        headers,
    };

    const proxy = http.request(options, (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res, { end: true });
    });

    proxy.on('error', (err) => {
        console.error('Proxy error:', err.message);
        if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
        }
    });

    req.pipe(proxy, { end: true });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
    console.log(`MCP proxy listening on port ${LISTEN_PORT} → supergateway:${UPSTREAM_PORT}`);
});
