// app.ts — HTTP server: routing, auth, body handling, and the
// X-GitHub-Request-Id header on every reply.

import http from 'node:http';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertisementV2,
  advertisementV0,
  handleUploadPackV2,
  handleUploadPackV0,
  handleReceivePack,
  matchGitPath,
} from './gitproto.ts';
import { getRepo } from './store.ts';

let requestCounter = 0;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function expectedToken() {
  const t = process.env.MAKEFUN_SHOP_TOKEN;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

function authOk(req) {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const expected = expectedToken();
  if (expected === null) return m[1].length > 0; // local dev: any token
  return m[1] === expected;
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const headers = {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': `req-${++requestCounter}`,
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendResult(res, result) {
  const headers = {
    'X-GitHub-Request-Id': `req-${++requestCounter}`,
    ...(result.headers ?? {}),
  };
  res.writeHead(result.status, headers);
  res.end(result.body ?? '');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createAppServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      let path = url.pathname;
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      const method = req.method ?? 'GET';

      // Health check: no auth, always 200.
      if (path === '/healthz') {
        if (method === 'GET' || method === 'HEAD') {
          sendJson(res, 200, { ok: true });
          return;
        }
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }

      // Everything else requires a valid bearer token.
      if (!authOk(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }

      const body = await readBody(req);
      const segments = path.split('/').filter(Boolean).map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
      const ctx = {
        method,
        path,
        segments,
        query: url.searchParams,
        body,
        host: req.headers.host ?? 'localhost',
        headers: req.headers,
      };

      // REST v3
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const restCtx = { ...ctx, segments: segments.slice(2) };
        sendResult(res, handleRest(restCtx));
        return;
      }

      // GraphQL
      if (path === '/api/graphql') {
        sendResult(res, handleGraphQL(ctx));
        return;
      }

      // MCP
      if (path === '/mcp') {
        sendResult(res, handleMcp(ctx));
        return;
      }

      // Git smart HTTP
      const git = matchGitPath(path);
      if (git) {
        const repo = getRepo(git.owner, git.name);
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (git.endpoint === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (service === 'git-upload-pack') {
            const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            const ad = v2 ? advertisementV2() : advertisementV0(repo, service);
            res.writeHead(200, {
              'Content-Type': 'application/x-git-upload-pack-advertisement',
              'X-GitHub-Request-Id': `req-${++requestCounter}`,
            });
            res.end(ad);
            return;
          }
          if (service === 'git-receive-pack') {
            const ad = advertisementV0(repo, service);
            res.writeHead(200, {
              'Content-Type': 'application/x-git-receive-pack-advertisement',
              'X-GitHub-Request-Id': `req-${++requestCounter}`,
            });
            res.end(ad);
            return;
          }
          sendJson(res, 400, { message: 'service parameter is required' });
          return;
        }
        if (git.endpoint === 'git-upload-pack' && method === 'POST') {
          const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
          let out;
          try {
            out = v2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
          } catch (e) {
            sendJson(res, 400, { message: e && e.message ? e.message : 'Bad request' });
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'application/x-git-upload-pack-result',
            'X-GitHub-Request-Id': `req-${++requestCounter}`,
          });
          res.end(out);
          return;
        }
        if (git.endpoint === 'git-receive-pack' && method === 'POST') {
          let out;
          try {
            out = handleReceivePack(repo, body);
          } catch (e) {
            sendJson(res, 400, { message: e && e.message ? e.message : 'Bad request' });
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'application/x-git-receive-pack-result',
            'X-GitHub-Request-Id': `req-${++requestCounter}`,
          });
          res.end(out);
          return;
        }
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = e && typeof e.status === 'number' ? e.status : 500;
      const message = e && e.message ? e.message : 'Internal Server Error';
      if (status === 500) console.error('handler error:', e);
      sendJson(res, status, { message });
    }
  });
  return server;
}
