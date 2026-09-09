import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { bridgeApiUrl, normalizeBridgeBaseUrl } from '../extension/security.js';

test('extension is Manifest V3 and has no remote code or broad hosts', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions.sort(), [
    'http://127.0.0.1/*',
    'https://chatgpt.com/*',
  ].sort());
  const html = await fs.readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
  const source = `${await fs.readFile(new URL('../extension/background.js', import.meta.url), 'utf8')}\n${await fs.readFile(new URL('../extension/content.js', import.meta.url), 'utf8')}`;
  assert.doesNotMatch(source, /eval\s*\(|new\s+Function\s*\(/);
  assert.match(source, /chrome\.storage\.session\.set\(\{ token: next\.token \}\)/u);
  assert.doesNotMatch(source, /chrome\.storage\.local\.set\(next\)/u);
  assert.match(source, /\/bridge\/challenge/u);
  assert.match(source, /x-relu-request-proof/u);
  assert.doesNotMatch(source, /authorization:\s*`Bearer/u);
  const popup = await fs.readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /item\.allowedDecisions/);
  assert.match(popup, /JSON\.stringify\(item\.displayDetails/u);
  assert.match(popup, /details\.textContent/u);
});

test('extension authenticates an exact 127.0.0.1 origin without a raw bearer request', () => {
  assert.equal(normalizeBridgeBaseUrl('http://127.0.0.1:5746/'), 'http://127.0.0.1:5746');
  assert.equal(
    bridgeApiUrl('http://127.0.0.1:5746', '/bridge/state?conversationId=test'),
    'http://127.0.0.1:5746/bridge/state?conversationId=test',
  );
  for (const unsafe of [
    'https://chatgpt.com',
    'http://localhost:5746',
    'http://127.0.0.1.evil.example:5746',
    'http://127.0.0.1:5746/path',
    'http://user:pass@127.0.0.1:5746',
    'http://127.0.0.1',
  ]) assert.throws(() => normalizeBridgeBaseUrl(unsafe), /exact origin|형식/u);
  assert.throws(() => bridgeApiUrl('http://127.0.0.1:5746', '//evil.example/leak'), /path/u);
  assert.throws(() => bridgeApiUrl('http://127.0.0.1:5746', '/\\evil.example/leak'), /path/u);
});

test('Perfetto plugin keeps its connector token in page memory only', async () => {
  const source = await fs.readFile(new URL('../plugin/io.company.RELUPerfettoBridge/index.ts', import.meta.url), 'utf8');
  const bootstrap = await fs.readFile(new URL('../plugin/io.company.RELUPerfettoBridge/bootstrap.ts', import.meta.url), 'utf8');
  assert.match(source, /private static bridgeToken = '';/u);
  assert.doesNotMatch(`${source}\n${bootstrap}`, /#BridgeToken|bridgeTokenSetting|localStorage|sessionStorage|\.set\(token\)/u);
  assert.doesNotMatch(source, /Perfetto connector 전용 token/u);
  assert.match(bootstrap, /PERFETTO_BOOTSTRAP_PATH = '\/relu\/perfetto-bootstrap'/u);
  assert.match(bootstrap, /method: 'POST'/u);
  assert.match(bootstrap, /cache: 'no-store'/u);
  assert.match(bootstrap, /endpoint: `ws:\/\/\$\{pageLocation\.hostname\}:\$\{pageLocation\.port\}\/perfetto\/ws`/u);
});

test('viewer integrations expose MCP without embedding an AI panel or CLI runner', async () => {
  const plugin = await fs.readFile(new URL('../plugin/io.company.RELUPerfettoBridge/index.ts', import.meta.url), 'utf8');
  const client = await fs.readFile(new URL('../plugin/io.company.RELUPerfettoBridge/bridge_client.ts', import.meta.url), 'utf8');
  const broker = await fs.readFile(new URL('../src/perfetto-broker.mjs', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const wpf = await fs.readFile(new URL('../examples/wpf-android-log-viewer/ReluWpfIntegration.cs', import.meta.url), 'utf8');
  const perfettoInstructions = await fs.readFile(new URL('../skills/relu-analyze-selection/references/perfetto.md', import.meta.url), 'utf8');

  const viewerSources = `${plugin}\n${client}\n${broker}\n${server}\n${wpf}`;
  assert.doesNotMatch(viewerSources, /AnalysisPanel|analysis\.start_requested|analysis\.focus_requested|codex\s+exec/u);
  assert.doesNotMatch(plugin, /sidePanel\.registerTab|OpenAnalysis/u);
  assert.match(perfettoInstructions, /perfetto_select_area/u);
  assert.match(perfettoInstructions, /URL로 출력하지 않는다/u);
  assert.match(perfettoInstructions, /실제 Perfetto tab/u);
});
