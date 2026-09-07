import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {ensureCodexRegistration} from '../src/codex-registration.mjs';
import {
  perfettoRuntimeFile,
  publishPerfettoRuntime,
  readPerfettoRuntime,
  removePerfettoRuntime,
} from '../src/perfetto-codex-runtime.mjs';
import {createCodexMcpRelay} from '../scripts/perfetto/codex-mcp-proxy.mjs';
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
      codexCli: null,
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

test('private runtime descriptor is bounded, exclusive to a live stack, and owner-cleaned', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-runtime-test-'));
  await fs.chmod(temporary, 0o700);
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const runtimeFile = path.join(temporary, 'runtime', 'perfetto-local-v1.json');
  const descriptor = {
    version: 1,
    instanceId: 'a'.repeat(32),
    pid: process.pid,
    bridgeUrl: 'http://127.0.0.1:5746/mcp',
    bridgeVersion: '0.7.0',
    token: 'runtime_control_token_0123456789',
    createdAt: new Date().toISOString(),
  };
  await publishPerfettoRuntime(descriptor, runtimeFile);
  assert.deepEqual(await readPerfettoRuntime(runtimeFile), descriptor);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(runtimeFile)).mode & 0o077, 0);
  }
  await assert.rejects(
    publishPerfettoRuntime({...descriptor, instanceId: 'b'.repeat(32)}, runtimeFile),
    /Another live/u,
  );
  assert.equal(await removePerfettoRuntime('b'.repeat(32), runtimeFile), false);
  assert.equal(await removePerfettoRuntime(descriptor.instanceId, runtimeFile), true);
  assert.match(perfettoRuntimeFile(temporary), /relu-ai-bridge-runtime/u);
});

test('Codex stdio relay authenticates without exposing the runtime token and keeps the MCP session', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-relay-test-'));
  await fs.chmod(temporary, 0o700);
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const token = 'runtime_control_token_0123456789';
  let closedSession = null;
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/health') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ok: true, name: 'relu-ai-bridge', version: '0.7.0', mcpAuth: 'bearer'}));
    }
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.method === 'DELETE') {
      closedSession = request.headers['mcp-session-id'];
      return response.end('{}');
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({body: JSON.parse(body), session: request.headers['mcp-session-id'] ?? null});
    if (requests.length === 1) {
      response.setHeader('mcp-session-id', 'mcp_test_session');
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({jsonrpc: '2.0', id: 1, result: {protocolVersion: '2025-06-18'}}));
    }
    response.writeHead(202);
    response.end();
  });
  const bridgePort = await listen(server);
  t.after(() => close(server));
  const runtimeFile = path.join(temporary, 'runtime', 'perfetto-local-v1.json');
  await publishPerfettoRuntime({
    version: 1,
    instanceId: 'c'.repeat(32),
    pid: process.pid,
    bridgeUrl: `http://127.0.0.1:${bridgePort}/mcp`,
    bridgeVersion: '0.7.0',
    token,
    createdAt: new Date().toISOString(),
  }, runtimeFile);
  const relay = await createCodexMcpRelay({runtimeFile});
  const initialized = await relay.request({jsonrpc: '2.0', id: 1, method: 'initialize'});
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(JSON.stringify(initialized).includes(token), false);
  assert.equal(await relay.request({jsonrpc: '2.0', method: 'notifications/initialized'}), null);
  assert.equal(requests[1].session, 'mcp_test_session');
  await relay.close();
  assert.equal(closedSession, 'mcp_test_session');
});

function fakeSpawn(sequence) {
  return (_command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const next = sequence.shift();
    process.nextTick(() => {
      child.stdout.end(next.stdout ?? '');
      child.stderr.end(next.stderr ?? '');
      child.emit('exit', next.code, null);
    });
    child.args = args;
    child.options = options;
    return child;
  };
}

test('Codex registration is idempotent and preserves conflicting user entries', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-register-test-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const codexCli = path.join(temporary, 'codex');
  const nodePath = path.join(temporary, 'node');
  const proxyPath = path.join(temporary, 'proxy.mjs');
  await Promise.all([codexCli, nodePath, proxyPath].map((file) => fs.writeFile(file, 'test')));
  const realCodexCli = await fs.realpath(codexCli);
  const realNodePath = await fs.realpath(nodePath);
  const realProxyPath = await fs.realpath(proxyPath);
  const exact = JSON.stringify({
    name: 'relu-perfetto', enabled: true,
    transport: {type: 'stdio', command: realNodePath, args: [realProxyPath], env: null, env_vars: []},
  });
  const missing = {code: 1, stderr: "Error: No MCP server named 'relu-perfetto' found."};
  const registrationSpawn = fakeSpawn([missing, missing, {code: 0}, {code: 0, stdout: exact}]);
  process.env.COMPANY_REGISTRATION_TOKEN = 'must-not-reach-codex';
  try {
    const registered = await ensureCodexRegistration({
      codexCli: realCodexCli, nodePath: realNodePath, proxyPath: realProxyPath,
      spawnImpl: (command, args, options) => {
        assert.equal(options.shell, false);
        assert.equal(options.env.COMPANY_REGISTRATION_TOKEN, undefined);
        return registrationSpawn(command, args, options);
      },
    });
    assert.deepEqual(registered, {state: 'registered', restartRequired: true});
  } finally {
    delete process.env.COMPANY_REGISTRATION_TOKEN;
  }
  const existing = await ensureCodexRegistration({
    codexCli: realCodexCli, nodePath: realNodePath, proxyPath: realProxyPath,
    spawnImpl: fakeSpawn([{code: 0, stdout: exact}]),
  });
  assert.deepEqual(existing, {state: 'already-registered', restartRequired: false});
  const conflict = JSON.stringify({
    name: 'relu-perfetto', enabled: true,
    transport: {type: 'stdio', command: '/different/node', args: ['/different/proxy'], env: null, env_vars: []},
  });
  await assert.rejects(
    ensureCodexRegistration({
      codexCli: realCodexCli, nodePath: realNodePath, proxyPath: realProxyPath,
      spawnImpl: fakeSpawn([{code: 0, stdout: conflict}]),
    }),
    /preserved/u,
  );
});

test('launchers use the bundled Perfetto Node runtime and pin the Windows baseline', async () => {
  const launcher = await fs.readFile(
    new URL('../scripts/perfetto/run-local-stack.mjs', import.meta.url),
    'utf8',
  );
  const powershell = await fs.readFile(
    new URL('../scripts/perfetto/run-local-stack.ps1', import.meta.url),
    'utf8',
  );
  assert.match(launcher, /process\.platform === 'win32' \? 'node\.exe' : 'node'/u);
  assert.match(launcher, /path\.join\(options\.perfettoDir, 'ui', 'build\.mjs'\)/u);
  assert.match(launcher, /shell: false/u);
  const shellLauncher = await fs.readFile(
    new URL('../scripts/perfetto/run-local-stack.sh', import.meta.url),
    'utf8',
  );
  assert.match(shellLauncher, /codesign --verify --strict/u);
  assert.match(powershell, /add693d8b338ba9599dbcbc3e300b1ab8c000897/u);
  assert.match(powershell, /ui\\node\.exe/u);
  assert.match(powershell, /Get-AuthenticodeSignature/u);
  assert.match(powershell, /OpenAI OpCo, LLC/u);
  assert.match(powershell, /Global\\Relu\.AI\.Bridge\.Perfetto\.McpRegistration/u);
  assert.doesNotMatch(powershell, /Invoke-Expression|Start-Process/u);
});
