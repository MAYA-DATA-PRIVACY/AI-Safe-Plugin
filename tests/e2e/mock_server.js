/**
 * mock_server.js — Lightweight Node.js mock for the GLiNER2 local server (CommonJS).
 *
 * Serves:
 *   GET  /health  →  { ok: true, loaded: true, model: "mock", ... }
 *   POST /detect  →  { ok: true, detections: [...configurable...] }
 *
 * Usage:
 *   const { startMockServer, stopMockServer, isPortBusy } = require('./mock_server');
 *   const server = await startMockServer({ port: 8765, detections: [...], pages: { '/fixture': '<html>...</html>' } });
 *   await stopMockServer(server);
 */
const http = require('http');
const net = require('net');

const DEFAULT_PORT = 8765;

/**
 * Check if a TCP port is already in use.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortBusy(port) {
    return new Promise((resolve) => {
        const probe = net.createConnection({ port, host: '127.0.0.1' });
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', () => { resolve(false); });
    });
}

/**
 * Start a mock GLiNER2 server.
 * Throws if port 8765 is already in use so E2E does not silently depend on
 * a stray real local server.
 *
 * @param {object}  opts
 * @param {number}  [opts.port]
 * @param {Array}   [opts.detections]
 * @param {boolean} [opts.loaded]
 * @param {boolean} [opts.healthy]
 * @param {Object.<string, string|Function>} [opts.pages]
 * @param {Object.<string, Function>} [opts.handlers]
 * @returns {Promise<http.Server>}
 */
async function startMockServer({ port = DEFAULT_PORT, detections = [], loaded = true, healthy = true, pages = {}, handlers = {} } = {}) {
    const busy = await isPortBusy(port);
    if (busy) {
        throw new Error(`[mock_server] Port ${port} is already in use. Stop the local MAYA AISafe Plugin server before running E2E tests.`);
    }

    return new Promise((resolve, reject) => {
        const state = {};
        const server = http.createServer((req, res) => {
            const cors = {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
                'Content-Type': 'application/json',
            };

            if (req.method === 'OPTIONS') {
                res.writeHead(204, cors);
                res.end();
                return;
            }

            const url = new URL(req.url, `http://localhost:${port}`);
            const handlerKey = `${req.method} ${url.pathname}`;

            if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(pages, url.pathname)) {
                const page = typeof pages[url.pathname] === 'function'
                    ? pages[url.pathname](url)
                    : pages[url.pathname];
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                });
                res.end(String(page));
                return;
            }

            if (Object.prototype.hasOwnProperty.call(handlers, handlerKey)) {
                let body = '';
                req.on('data', (chunk) => { body += chunk; });
                req.on('end', async () => {
                    try {
                        const result = await handlers[handlerKey]({
                            req,
                            res,
                            url,
                            body,
                            state,
                            cors,
                        });
                        if (result === false || res.writableEnded) return;

                        const status = Number(result?.status || 200);
                        const headers = {
                            ...cors,
                            ...(result?.headers || {}),
                        };
                        let responseBody = result?.body;
                        if (responseBody == null) responseBody = { ok: true };
                        if (typeof responseBody !== 'string') {
                            responseBody = JSON.stringify(responseBody);
                        }
                        res.writeHead(status, headers);
                        res.end(responseBody);
                    } catch (error) {
                        console.error('[mock_server] Handler error:', error);
                        res.writeHead(500, cors);
                        res.end(JSON.stringify({ ok: false, error: 'Internal mock server error' }));
                    }
                });
                return;
            }

            if (req.method === 'GET' && url.pathname === '/health') {
                res.writeHead(healthy ? 200 : 503, cors);
                res.end(JSON.stringify({
                    ok: healthy,
                    provider: 'mock-gliner2',
                    model: 'mock/gliner2-test',
                    loaded,
                    anonymizationProxy: false,
                    authRequired: false,
                }));
                return;
            }

            if (req.method === 'POST' && url.pathname === '/detect') {
                let body = '';
                req.on('data', (chunk) => { body += chunk; });
                req.on('end', () => {
                    res.writeHead(200, cors);
                    res.end(JSON.stringify({ ok: true, detections }));
                });
                return;
            }

            res.writeHead(404, cors);
            res.end(JSON.stringify({ ok: false, error: 'Not found' }));
        });
        const sockets = new Set();

        server.keepAliveTimeout = 1000;
        server.headersTimeout = 2000;
        server.requestTimeout = 2000;

        server.on('connection', (socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        });
        server.__activeSockets = sockets;
        server.__state = state;

        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

/**
 * @param {http.Server|undefined} server
 * @returns {Promise<void>}
 */
function stopMockServer(server) {
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => {
        if (typeof server.closeIdleConnections === 'function') {
            server.closeIdleConnections();
        }
        if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }
        if (server.__activeSockets instanceof Set) {
            server.__activeSockets.forEach((socket) => {
                try {
                    socket.destroy();
                } catch (error) {
                    // Best-effort teardown for test sockets.
                }
            });
        }
        server.close((err) => (err ? reject(err) : resolve()));
    });
}

module.exports = { startMockServer, stopMockServer, isPortBusy };
