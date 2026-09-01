import http from 'node:http';
import fs from 'node:fs/promises';
import { URL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createRedactor, authorizeRequest } from './security.mjs';
import { AuditLog } from './audit.mjs';
import { SessionStore } from './sessions.mjs';
import { AgentBroker } from './agents.mjs';
import { ApprovalStore } from './approvals.mjs';
import { FileTools } from './tools/files.mjs';
import { CommandManager } from './tools/commands.mjs';
import { BrowserBridge } from './bridge.mjs';
import { McpService } from './mcp.mjs';
import { PerfettoSessionStore } from './perfetto-store.mjs';
import { PerfettoBroker } from './perfetto-broker.mjs';
import { ConnectorBroker } from './connectors.mjs';
import { acceptWebSocket } from './websocket.mjs';
import { errorMessage, readRequestBody, sendJson } from './utils.mjs';
import { acquireDataDirectoryLock } from './instance-lock.mjs';
import { HttpProofBroker } from './http-proof.mjs';

const ADMIN_FILES = new Map([
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/admin/admin.css', ['admin.css', 'text/css; charset=utf-8']],
]);

async function serveAdmin(response, pathname) {
  const entry = ADMIN_FILES.get(pathname);
  if (!entry) return false;
  const payload = await fs.readFile(new URL(`../web/${entry[0]}`, import.meta.url));
  response.writeHead(200, {
    'content-type': entry[1],
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  response.end(payload);
  return true;
}

function isAllowedHttpOrigin(config, request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (origin === `http://${request.headers.host}`) return true;
  if (config.server.allowedHttpOrigins.includes(origin)) return true;
  const extension = origin.match(/^chrome-extension:\/\/([a-p]{32})$/u);
  return Boolean(extension && config.server.allowedChromeExtensionIds.includes(extension[1]));
}

function corsHeaders(config, request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  if (isAllowedHttpOrigin(config, request)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, x-relu-client-nonce, x-relu-server-nonce, x-relu-request-proof',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      vary: 'Origin',
    };
  }
  return {};
}

function isAllowedLoopbackHostHeader(value) {
  if (typeof value !== 'string' || value.length > 255) return false;
  const match = value.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i);
  if (!match) return false;
  return match[2] === undefined || Number(match[2]) <= 65535;
}

export async function createApplication(options = {}) {
  const config = options.config ?? await loadConfig(options);
  const instanceLock = await acquireDataDirectoryLock(config.dataDir);
  const httpProofs = new HttpProofBroker(config.server.token);
  const redactor = createRedactor(config);
  const audit = new AuditLog(config, redactor);
  const sessions = new SessionStore(config, redactor);
  const agents = new AgentBroker(config);
  const approvals = new ApprovalStore(config);
  const files = new FileTools(config, redactor);
  const commands = new CommandManager(config, redactor);
  const perfettoStore = new PerfettoSessionStore(config);
  let perfetto;
  let connectors;
  try {
    await Promise.all([sessions.initialize(), agents.initialize(), approvals.initialize(), perfettoStore.initialize(), audit.prune()]);
    perfetto = new PerfettoBroker(config, perfettoStore, audit, approvals);
    connectors = new ConnectorBroker(config, audit);
    await connectors.initialize();
  } catch (error) {
    perfetto?.shutdown();
    await connectors?.shutdown().catch(() => {});
    await instanceLock.release().catch(() => {});
    throw error;
  }
  const bridge = new BrowserBridge(config, sessions, agents, approvals, audit);
  const context = { config, redactor, audit, sessions, agents, approvals, files, commands, bridge, perfetto, perfettoStore, connectors };
  const mcp = new McpService(context);
  context.mcp = mcp;
  const pruneRetention = () => Promise.all([sessions.prune(), audit.prune()]);
  const retentionTimer = setInterval(() => void pruneRetention().catch(() => {}), 6 * 60 * 60_000);
  retentionTimer.unref?.();
  context.pruneRetention = pruneRetention;

  const server = http.createServer((request, response) => {
    void (async () => {
      try {
    if (!isAllowedLoopbackHostHeader(request.headers.host)) {
      return sendJson(response, 400, { error: 'Invalid Host header' });
    }
    const requestTarget = request.url ?? '/';
    if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) {
      return sendJson(response, 400, { error: 'Invalid request target' });
    }
    const requestUrl = new URL(requestTarget, 'http://127.0.0.1');
    if (!isAllowedHttpOrigin(config, request)) {
      return sendJson(response, 403, { error: 'Origin is not allowed' });
    }
    const headers = corsHeaders(config, request);
    if (request.method === 'OPTIONS') {
      response.writeHead(Object.keys(headers).length ? 204 : 403, headers);
      return response.end();
    }
    if (requestUrl.pathname === '/health') {
      return sendJson(response, 200, {
        ok: true,
        name: 'relu-ai-bridge',
        version: '0.3.0',
        auth: config.server.auth,
        mcpAuth: config.server.mcpAuth,
        roots: config.roots.length,
        uptimeSeconds: Math.floor(process.uptime()),
        perfettoClients: perfetto.listClients().length,
        connectorSessions: connectors.listSessions().length,
      }, headers);
    }
    if (request.method === 'GET' && await serveAdmin(response, requestUrl.pathname)) return;
    if (requestUrl.pathname === '/bridge/challenge') {
      const extension = String(request.headers.origin ?? '').match(/^chrome-extension:\/\/([a-p]{32})$/u);
      if (request.method !== 'POST' || !extension || !config.server.allowedChromeExtensionIds.includes(extension[1])) {
        return sendJson(response, 403, { error: 'Bridge challenge is restricted to an allowed Chrome extension' }, headers);
      }
      const body = await readRequestBody(request, Math.min(config.server.maxRequestBytes, 4096));
      return sendJson(response, 200, httpProofs.issue(request.headers.origin, body), headers);
    }
    const isMcpPath = requestUrl.pathname === '/mcp' || requestUrl.pathname.startsWith('/mcp/');
    const authMode = isMcpPath ? config.server.mcpAuth : config.server.auth;
    const proofAuthorization = requestUrl.pathname.startsWith('/bridge/')
      ? httpProofs.consume(request, request.headers.origin)
      : null;
    if (!authorizeRequest(config, request, authMode, requestUrl.pathname) && !proofAuthorization) {
      response.setHeader('www-authenticate', 'Bearer realm="relu-ai-bridge"');
      return sendJson(response, 401, { error: 'Unauthorized' }, headers);
    }
    try {
      if (isMcpPath) {
        if (request.method === 'GET') {
          return sendJson(response, 405, { error: 'This server uses JSON responses over Streamable HTTP; send JSON-RPC with POST.' }, {
            ...headers,
            allow: 'POST, DELETE, OPTIONS',
          });
        }
        if (request.method === 'DELETE') {
          const closed = typeof request.headers['mcp-session-id'] === 'string'
            ? await mcp.closeSession(request.headers['mcp-session-id'])
            : false;
          return sendJson(response, 200, { ok: true, closed }, headers);
        }
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' }, headers);
        const body = await readRequestBody(request, config.server.maxRequestBytes);
        const messages = Array.isArray(body) ? body : [body];
        if (messages.length === 0 || messages.length > 100) {
          return sendJson(response, 400, {
            jsonrpc: '2.0', id: null,
            error: { code: -32600, message: 'JSON-RPC batch must contain 1 to 100 items' },
          }, headers);
        }
        const handled = [];
        let mcpSessionId = request.headers['mcp-session-id'];
        for (const message of messages) {
          const item = await mcp.handle(message, { mcpSessionId });
          if (item.sessionId) mcpSessionId = item.sessionId;
          if (item.response) handled.push(item.response);
        }
        if (handled.length === 0) {
          response.writeHead(202, { ...headers, ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}) });
          return response.end();
        }
        return sendJson(response, 200, Array.isArray(body) ? handled : handled[0], {
          ...headers,
          ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
          'mcp-protocol-version': '2025-06-18',
        });
      }
      if (requestUrl.pathname.startsWith('/bridge/')) {
        const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await readRequestBody(request, config.server.maxRequestBytes) : null;
        if (proofAuthorization && !httpProofs.requestMatches(proofAuthorization, request, body)) {
          return sendJson(response, 401, { error: 'Bridge request authentication failed' }, headers);
        }
        const result = await bridge.handle(request.method, requestUrl.pathname, requestUrl.searchParams, body);
        return sendJson(response, 200, result, headers);
      }
      if (requestUrl.pathname === '/api/v1/perfetto/clients' && request.method === 'GET') {
        return sendJson(response, 200, { clients: perfetto.listClients() }, headers);
      }
      if (requestUrl.pathname === '/api/v1/relu/sessions' && request.method === 'GET') {
        return sendJson(response, 200, {
          sessions: connectors.listSessions(),
          perfetto: perfetto.listClients(),
        }, headers);
      }
      if (requestUrl.pathname === '/api/v1/relu/operations' && request.method === 'GET') {
        return sendJson(response, 200, { operations: connectors.listOperations() }, headers);
      }
      const operationMatch = requestUrl.pathname.match(/^\/api\/v1\/relu\/operations\/(op_[a-f0-9]{32})\/reconcile$/u);
      if (operationMatch && request.method === 'POST') {
        const body = await readRequestBody(request, config.server.maxRequestBytes);
        if (!['confirmed_applied', 'confirmed_not_applied'].includes(body?.decision)) {
          const error = new Error('Invalid operation reconciliation decision');
          error.statusCode = 400;
          throw error;
        }
        const operation = connectors.getOperation(operationMatch[1]);
        if (operation.status !== 'ambiguous') {
          const error = new Error('Ambiguous operation not found');
          error.statusCode = 409;
          throw error;
        }
        await approvals.require({
          scope: `relu.operation.reconcile:${operation.id}:${body.decision}:${operation.createdAt}`,
          summary: `Reconcile ambiguous operation ${operation.id}`,
          details: {
            decision: body.decision,
            serviceId: operation.serviceId,
            capability: operation.capability,
            operationId: operation.operationId,
            argumentsHash: operation.argumentsHash,
            createdAt: operation.createdAt,
          },
          displayDetails: {
            action: 'operation-reconcile',
            decision: body?.decision ?? null,
            serviceId: operation.serviceId,
            capability: operation.capability,
            operationKey: operation.id,
          },
          sessionId: null,
          allowedDecisions: ['once', 'deny'],
        });
        return sendJson(response, 200, await connectors.reconcileOperation(operationMatch[1], body.decision), headers);
      }
      if (requestUrl.pathname === '/api/v1/perfetto/sessions' && request.method === 'GET') {
        return sendJson(response, 200, { sessions: perfettoStore.list() }, headers);
      }
      if (requestUrl.pathname === '/api/v1/perfetto/sessions' && request.method === 'POST') {
        const body = await readRequestBody(request, config.server.maxRequestBytes);
        await approvals.require({
          scope: 'perfetto.session.create',
          summary: 'Create a durable REF/DUT Perfetto session',
          details: { name: body?.name ?? null, source: 'admin' },
          displayDetails: { action: 'create', source: 'admin', name: String(body?.name ?? 'REF/DUT session').slice(0, 100) },
          sessionId: null,
        });
        return sendJson(response, 201, await perfettoStore.create({ name: body?.name }), headers);
      }
      const attachMatch = requestUrl.pathname.match(/^\/api\/v1\/perfetto\/sessions\/([a-zA-Z0-9_-]{3,128})\/attach$/);
      if (attachMatch && request.method === 'POST') {
        const body = await readRequestBody(request, config.server.maxRequestBytes);
        return sendJson(response, 200, await perfetto.requestAttach(attachMatch[1], body?.role, body?.clientId, 'admin'), headers);
      }
      return sendJson(response, 404, { error: 'Not found' }, headers);
    } catch (error) {
      await audit.append({ category: 'http', action: `${request.method} ${isMcpPath ? '/mcp' : requestUrl.pathname}`, error: errorMessage(error) });
      return sendJson(response, error.statusCode ?? 500, { error: errorMessage(error) }, headers);
    }
      } catch (error) {
        await audit.append({ category: 'http', action: 'malformed-request', error: errorMessage(error) });
        if (!response.headersSent) return sendJson(response, 400, { error: 'Bad Request' });
        response.destroy();
      }
    })();
  });

  server.on('upgrade', (request, socket, head) => {
    try {
      if (!isAllowedLoopbackHostHeader(request.headers.host)) throw new Error('Invalid Host header');
      const requestTarget = request.url ?? '/';
      if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) throw new Error('Invalid request target');
      const requestUrl = new URL(requestTarget, 'http://127.0.0.1');
      const isPerfettoSocket = config.perfetto.enabled && requestUrl.pathname === config.perfetto.websocketPath;
      const isConnectorSocket = config.connectors.enabled && requestUrl.pathname === config.connectors.websocketPath;
      if (!isPerfettoSocket && !isConnectorSocket) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      const origin = request.headers.origin;
      const allowedOrigins = isPerfettoSocket ? config.perfetto.allowedOrigins : config.connectors.allowedOrigins;
      if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      const connection = acceptWebSocket(request, socket, head, {
        maxMessageBytes: isPerfettoSocket
          ? config.perfetto.maxWebSocketMessageBytes
          : config.connectors.maxWebSocketMessageBytes,
      });
      if (connection) {
        if (isPerfettoSocket) perfetto.accept(connection, { origin });
        else connectors.accept(connection, { origin });
      }
    } catch {
      socket.destroy();
    }
  });

  let closed = false;
  return {
    config,
    context,
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.server.port, config.server.host, resolve);
      });
      return server.address();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(retentionTimer);
      await commands.shutdown();
      perfetto.shutdown();
      try {
        await connectors.shutdown();
        if (server.listening) {
          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
      } finally {
        await instanceLock.release();
      }
    },
  };
}

export async function startServer(options = {}) {
  const app = await createApplication(options);
  let address;
  try {
    address = await app.listen();
  } catch (error) {
    await app.close();
    throw error;
  }
  const host = typeof address === 'object' && address ? address.address : app.config.server.host;
  const port = typeof address === 'object' && address ? address.port : app.config.server.port;
  process.stdout.write(`RELU AI Bridge listening on http://${host}:${port}\n`);
  const stop = async (signal) => {
    process.stdout.write(`Received ${signal}; shutting down\n`);
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  return app;
}
