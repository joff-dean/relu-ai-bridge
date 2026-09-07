import http from 'node:http';

export const PERFETTO_BOOTSTRAP_PATH = '/relu/perfetto-bootstrap';

const LOOPBACK_HOST = '127.0.0.1';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function validatePort(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function validateConnectorToken(value) {
  if (typeof value !== 'string' || value.length < 24 || value.length > 4096) {
    throw new Error('connectorToken must contain 24 to 4096 characters');
  }
  return value;
}

function copyEndToEndHeaders(headers, host) {
  const result = { host };
  for (const [name, value] of Object.entries(headers)) {
    if (
      name.toLowerCase() !== 'host'
      && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())
      && value !== undefined
    ) {
      result[name] = value;
    }
  }
  return result;
}

function copyResponseHeaders(source, response) {
  for (const [name, value] of Object.entries(source)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      response.setHeader(name, value);
    }
  }
}

function sendJson(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    expires: '0',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  response.end(payload);
}

function isExactBootstrapRequest(request, origin) {
  return request.method === 'POST'
    && request.headers.host === origin.slice('http://'.length)
    && request.headers.origin === origin
    && request.headers['sec-fetch-site'] === 'same-origin'
    && request.headers['sec-fetch-mode'] === 'cors'
    && request.headers['sec-fetch-dest'] === 'empty'
    && String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
}

function rejectSocket(socket, statusCode, statusText) {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function proxyUpgrade(request, socket, head, target) {
  const proxyRequest = http.request({
    host: LOOPBACK_HOST,
    port: target.port,
    method: 'GET',
    path: request.url,
    headers: {
      ...copyEndToEndHeaders(request.headers, `${LOOPBACK_HOST}:${target.port}`),
      connection: 'Upgrade',
      upgrade: 'websocket',
    },
  });
  let upgraded = false;
  proxyRequest.once('upgrade', (proxyResponse, proxySocket, proxyHead) => {
    upgraded = true;
    socket.write(`HTTP/1.1 ${proxyResponse.statusCode} ${proxyResponse.statusMessage}\r\n`);
    for (const [name, value] of Object.entries(proxyResponse.headers)) {
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) socket.write(`${name}: ${item}\r\n`);
    }
    socket.write('\r\n');
    if (proxyHead.length > 0) socket.write(proxyHead);
    if (head.length > 0) proxySocket.write(head);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyRequest.once('response', (proxyResponse) => {
    proxyResponse.resume();
    if (!upgraded) rejectSocket(socket, 502, 'Bad Gateway');
  });
  proxyRequest.once('error', () => {
    if (!upgraded) rejectSocket(socket, 502, 'Bad Gateway');
  });
  proxyRequest.end();
}

/**
 * Perfetto UI와 RELU WebSocket을 하나의 exact loopback origin으로 묶는다.
 * connector credential은 고정 POST bootstrap에서만 반환되며 URL/log에 넣지 않는다.
 */
export function createPerfettoLocalProxy(options) {
  const publicPort = validatePort(options.publicPort, 'publicPort');
  const upstreamPort = validatePort(options.upstreamPort, 'upstreamPort');
  const bridgePort = validatePort(options.bridgePort, 'bridgePort');
  const connectorToken = validateConnectorToken(options.connectorToken);
  const origin = `http://${LOOPBACK_HOST}:${publicPort}`;

  const server = http.createServer((request, response) => {
    const requestUrl = request.url ?? '/';
    if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) {
      return sendJson(response, 400, {error: 'Invalid request target'});
    }
    const pathname = new URL(requestUrl, origin).pathname;
    if (pathname === PERFETTO_BOOTSTRAP_PATH) {
      request.resume();
      if (!isExactBootstrapRequest(request, origin)) {
        return sendJson(response, 403, {error: 'Bootstrap request rejected'});
      }
      return sendJson(response, 200, {version: 1, token: connectorToken});
    }
    if (request.headers.host !== origin.slice('http://'.length)) {
      request.resume();
      return sendJson(response, 400, {error: 'Invalid Host header'});
    }
    const proxyRequest = http.request({
      host: LOOPBACK_HOST,
      port: upstreamPort,
      method: request.method,
      path: requestUrl,
      headers: copyEndToEndHeaders(
        request.headers,
        `${LOOPBACK_HOST}:${upstreamPort}`,
      ),
    }, (proxyResponse) => {
      response.statusCode = proxyResponse.statusCode ?? 502;
      if (proxyResponse.statusMessage) response.statusMessage = proxyResponse.statusMessage;
      copyResponseHeaders(proxyResponse.headers, response);
      proxyResponse.pipe(response);
    });
    proxyRequest.once('error', () => {
      if (!response.headersSent) sendJson(response, 502, {error: 'Perfetto UI unavailable'});
      else response.destroy();
    });
    request.pipe(proxyRequest);
  });

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = request.url ?? '/';
    const pathname = requestUrl.startsWith('/') && !requestUrl.startsWith('//')
      ? new URL(requestUrl, origin).pathname
      : '';
    if (
      pathname !== '/perfetto/ws'
      || request.headers.host !== origin.slice('http://'.length)
      || request.headers.origin !== origin
    ) {
      return rejectSocket(socket, 403, 'Forbidden');
    }
    proxyUpgrade(request, socket, head, {port: bridgePort});
  });

  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  let closed = false;
  return {
    origin,
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(publicPort, LOOPBACK_HOST, resolve);
      });
      return server.address();
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!server.listening) return;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
