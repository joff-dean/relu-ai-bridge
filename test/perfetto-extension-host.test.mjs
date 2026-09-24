import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {brotliDecompressSync} from 'node:zlib';
import {
  perfettoRuntimeFile,
  publishPerfettoRuntime,
  readPerfettoRuntime,
  removePerfettoRuntime,
} from '../src/perfetto-runtime.mjs';
import {createDesktopMcpRelay} from '../scripts/perfetto/desktop-mcp-proxy.mjs';
import {buildPerfettoExtension, parseBuildExtensionArgs} from '../scripts/perfetto/build-extension.mjs';
import {
  appendInstallerBundle,
  parseWindowsInstallerArgs,
  verifyWindowsPe,
} from '../scripts/perfetto/build-windows-installer.mjs';
import {parseExtensionBridgeArgs} from '../scripts/perfetto/run-extension-bridge.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('Extension artifact is generated for one exact company Perfetto origin', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-extension-build-test-'));
  const output = path.join(temporary, 'extension');
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const options = parseBuildExtensionArgs([
    '--origin', 'https://perfetto.company.example', '--output', output,
  ]);
  await buildPerfettoExtension(options);
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://perfetto.company.example/*']);
  assert.match(await fs.readFile(path.join(output, 'policy.js'), 'utf8'), /https:\/\/perfetto\.company\.example/u);
  await assert.rejects(buildPerfettoExtension(options), /already exists/u);
  assert.throws(
    () => parseBuildExtensionArgs(['--origin', 'https://perfetto.company.example/path', '--output', output]),
    /exact HTTP\(S\) origin/u,
  );
});

test('Extension bridge arguments pin exact origins, Extension id, and one loopback port', () => {
  assert.deepEqual(parseExtensionBridgeArgs([
    '--extension-id', 'a'.repeat(32),
    '--origin', 'https://perfetto.company.example',
    '--bridge-port', '5746',
  ]), {
    extensionId: 'a'.repeat(32),
    origin: 'https://perfetto.company.example',
    bridgePort: 5746,
  });
  assert.throws(() => parseExtensionBridgeArgs(['--extension-id', 'z'.repeat(32), '--origin', 'https://perfetto.company.example']), /extension-id/u);
  assert.throws(() => parseExtensionBridgeArgs(['--extension-id', 'a'.repeat(32), '--origin', 'file:///trace']), /exact HTTP\(S\) origin/u);
});

test('private Native Host runtime descriptor is bounded, exclusive, and owner-cleaned', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-runtime-test-'));
  await fs.chmod(temporary, 0o700);
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const runtimeFile = path.join(temporary, 'runtime', 'perfetto-extension-v1.json');
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
  if (process.platform !== 'win32') assert.equal((await fs.stat(runtimeFile)).mode & 0o077, 0);
  await assert.rejects(publishPerfettoRuntime({...descriptor, instanceId: 'b'.repeat(32)}, runtimeFile), /Another live/u);
  assert.equal(await removePerfettoRuntime(descriptor.instanceId, runtimeFile), true);
  assert.match(perfettoRuntimeFile(temporary), /perfetto-extension-v1\.json$/u);
});

test('desktop AI stdio relay uses the private Native Host descriptor and preserves MCP sessions', async (t) => {
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
    response.writeHead(202).end();
  });
  const port = await listen(server);
  t.after(() => close(server));
  const runtimeFile = path.join(temporary, 'runtime', 'perfetto-extension-v1.json');
  await publishPerfettoRuntime({
    version: 1, instanceId: 'c'.repeat(32), pid: process.pid,
    bridgeUrl: `http://127.0.0.1:${port}/mcp`, bridgeVersion: '0.7.0', token,
    createdAt: new Date().toISOString(),
  }, runtimeFile);
  const relay = await createDesktopMcpRelay({runtimeFile});
  const initialized = await relay.request({jsonrpc: '2.0', id: 1, method: 'initialize'});
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(JSON.stringify(initialized).includes(token), false);
  assert.equal(await relay.request({jsonrpc: '2.0', method: 'notifications/initialized'}), null);
  assert.equal(requests[1].session, 'mcp_test_session');
  await relay.close();
  assert.equal(closedSession, 'mcp_test_session');
});

test('Windows one-click installer build contract pins exact managed Chrome and runtime inputs', () => {
  const options = parseWindowsInstallerArgs([
    '--origin', 'https://perfetto.company.example',
    '--extension-id', 'a'.repeat(32),
    '--extension-update-url', 'https://perfetto.company.example/relu-extension/updates.xml',
    '--node-exe', '/approved/node.exe',
    '--node-sha256', 'b'.repeat(64),
    '--output', '/tmp/RELU-Perfetto-Setup.exe',
  ]);
  assert.equal(options.bridgePort, 5746);
  assert.equal(options.runtimeId, 'win-x64');
  assert.throws(() => parseWindowsInstallerArgs([
    '--origin', 'https://perfetto.company.example',
    '--extension-id', 'a'.repeat(32),
    '--extension-update-url', 'http://perfetto.company.example/update.xml',
    '--node-exe', '/approved/node.exe',
    '--node-sha256', 'b'.repeat(64),
    '--output', '/tmp/RELU-Perfetto-Setup.exe',
  ]), /HTTPS URL/u);
  assert.throws(() => parseWindowsInstallerArgs([
    '--origin', 'https://perfetto.company.example',
    '--extension-id', 'a'.repeat(32),
    '--extension-update-url', 'https://perfetto.company.example/update.xml',
    '--node-exe', '/approved/node.exe',
    '--node-sha256', 'b'.repeat(64),
    '--output', path.join(process.cwd(), 'setup.exe'),
  ]), /outside the source repository/u);
});

test('Windows one-click installer appends a checksummed bounded payload to one executable', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-installer-archive-test-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const stub = path.join(temporary, 'stub.exe');
  const output = path.join(temporary, 'setup.exe');
  await fs.writeFile(stub, Buffer.from('MZ-test-stub'));
  const paths = [
    'Relu.AI.Bridge.PerfettoNativeHost.exe',
    'runtime/node.exe',
    'app/scripts/perfetto/run-extension-bridge.mjs',
    'app/scripts/perfetto/desktop-mcp-proxy.mjs',
    'app/scripts/skills/manage-skills.mjs',
    'app/skills/manifest.json',
  ];
  const files = [];
  for (const [index, relative] of paths.entries()) {
    const source = path.join(temporary, `source-${index}`);
    const content = Buffer.from(`payload-${relative}`);
    await fs.writeFile(source, content);
    files.push({source, path: relative, content});
  }
  const contract = await appendInstallerBundle({
    stub,
    files,
    output,
    contract: {
      product: 'relu-perfetto-connector',
      productVersion: '0.7.0',
      runtimeIdentifier: 'win-x64',
      extensionId: 'a'.repeat(32),
      perfettoOrigin: 'https://perfetto.company.example',
      extensionUpdateUrl: 'https://perfetto.company.example/relu-extension/updates.xml',
      bridgePort: 5746,
    },
  });
  const artifact = await fs.readFile(output);
  assert.equal(artifact.subarray(-16).toString('ascii'), 'RELU-PERFETTO-V1');
  const contractLength = artifact.readInt32LE(artifact.length - 20);
  const payloadLength = Number(artifact.readBigInt64LE(artifact.length - 28));
  assert.equal(payloadLength, contract.payloadBytes);
  const contractStart = artifact.length - 28 - contractLength;
  const parsed = JSON.parse(artifact.subarray(contractStart, artifact.length - 28));
  assert.equal(parsed.payloadSha256, contract.payloadSha256);
  const payloadStart = Buffer.byteLength('MZ-test-stub');
  const first = parsed.files[0];
  const expanded = brotliDecompressSync(artifact.subarray(
    payloadStart + first.offset,
    payloadStart + first.offset + first.compressedBytes,
  ));
  assert.deepEqual(expanded, files[0].content);
});

test('Windows installer builder rejects a Node runtime for the wrong PE architecture', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-installer-pe-test-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true}));
  const executable = path.join(temporary, 'node.exe');
  const pe = Buffer.alloc(512);
  pe.write('MZ', 0, 'ascii');
  pe.writeUInt32LE(128, 0x3c);
  pe.writeUInt32LE(0x00004550, 128);
  pe.writeUInt16LE(0x8664, 132);
  await fs.writeFile(executable, pe);
  await verifyWindowsPe(executable, 'win-x64');
  await assert.rejects(verifyWindowsPe(executable, 'win-arm64'), /architecture does not match/u);
});

test('Windows installer source uses only fixed user-scope registration and preserves conflicts', async () => {
  const source = await fs.readFile(new URL(
    '../sdk-dotnet/src/Relu.AI.Bridge.PerfettoInstaller/Program.cs', import.meta.url), 'utf8');
  assert.match(source, /Registry\.CurrentUser/u);
  assert.match(source, /ExtensionInstallForcelist/u);
  assert.match(source, /--relu-register-ai-clients/u);
  assert.match(source, /IsOwnedRegistration/u);
  assert.doesNotMatch(source, /Registry\.LocalMachine\.CreateSubKey|Invoke-Expression|Start-Process/u);
});
