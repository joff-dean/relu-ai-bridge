import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import {
  PERFETTO_BOOTSTRAP_PATH,
  createPerfettoLocalProxy,
} from '../src/perfetto-local-stack.mjs';
import {parseLocalStackArgs} from '../scripts/perfetto/run-local-stack.mjs';

const TOKEN = 'relu_perfetto_runtime_test_0123456789';

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test('same-origin bootstrap is POST-only, bounded, and never stored in a URL', async (t) => {
  const upstream = http.createServer((request, response) => {
    response.end(`upstream:${request.url}:${request.headers.host}`);
  });
  const bridge = http.createServer();
  const upstreamPort = await listen(upstream);
  const bridgePort = await listen(bridge);
  const publicPort = await freePort();
  const proxy = createPerfettoLocalProxy({
    publicPort,
    upstreamPort,
    bridgePort,
    connectorToken: TOKEN,
  });
  await proxy.listen();
  t.after(async () => {
    await proxy.close();
    await close(upstream);
    await close(bridge);
  });

  const response = await fetch(`${proxy.origin}${PERFETTO_BOOTSTRAP_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: proxy.origin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/u);
  assert.deepEqual(await response.json(), {version: 1, token: TOKEN});
  assert.equal(response.url.includes(TOKEN), false);

  const rejected = await fetch(`${proxy.origin}${PERFETTO_BOOTSTRAP_PATH}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: proxy.origin},
    body: '{}',
  });
  assert.equal(rejected.status, 403);

  const ui = await fetch(`${proxy.origin}/#!/viewer?local_cache_key=opaque`);
  assert.equal(
    await ui.text(),
    `upstream:/:${`127.0.0.1:${upstreamPort}`}`,
  );
});

test('only exact same-origin /perfetto/ws upgrades reach the bridge', async (t) => {
  const upstream = http.createServer((_request, response) => response.end('ui'));
  const bridge = http.createServer();
  bridge.on('upgrade', (request, socket) => {
    assert.equal(request.url, '/perfetto/ws');
    assert.equal(request.headers.origin, proxy.origin);
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: test\r\n\r\n' +
      'bridge-ok',
    );
  });
  const upstreamPort = await listen(upstream);
  const bridgePort = await listen(bridge);
  const publicPort = await freePort();
  const proxy = createPerfettoLocalProxy({
    publicPort,
    upstreamPort,
    bridgePort,
    connectorToken: TOKEN,
  });
  await proxy.listen();
  t.after(async () => {
    await proxy.close();
    await close(upstream);
    await close(bridge);
  });

  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(publicPort, '127.0.0.1');
    let received = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      received += chunk;
      if (received.includes('bridge-ok')) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.once('connect', () => socket.write(
      `GET /perfetto/ws HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${publicPort}\r\n` +
      `Origin: ${proxy.origin}\r\n` +
      'Connection: Upgrade\r\n' +
      'Upgrade: websocket\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Key: dGVzdA==\r\n\r\n',
    ));
  });
  assert.match(response, /^HTTP\/1\.1 101/u);

  const rejected = await new Promise((resolve, reject) => {
    const socket = net.connect(publicPort, '127.0.0.1');
    let received = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => { received += chunk; });
    socket.once('close', () => resolve(received));
    socket.once('connect', () => socket.write(
      `GET /perfetto/ws HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${publicPort}\r\n` +
      'Origin: http://127.0.0.1:9999\r\n' +
      'Connection: Upgrade\r\n' +
      'Upgrade: websocket\r\n\r\n',
    ));
  });
  assert.match(rejected, /^HTTP\/1\.1 403/u);
});

test('local stack supports multiple non-overlapping Perfetto instances', () => {
  assert.deepEqual(
    parseLocalStackArgs([
      '/work/perfetto',
      '--instances', '2',
      '--ui-port', '10000',
      '--upstream-port', '11000',
      '--bridge-port', '5746',
    ]),
    {
      perfettoDir: '/work/perfetto',
      instances: 2,
      uiPort: 10000,
      upstreamPort: 11000,
      bridgePort: 5746,
    },
  );
  assert.throws(
    () => parseLocalStackArgs([
      '/work/perfetto', '--ui-port', '5746', '--bridge-port', '5746',
    ]),
    /overlap/u,
  );
  assert.throws(
    () => parseLocalStackArgs(['/work/perfetto', '--instances', '9']),
    /at most 8/u,
  );
});
