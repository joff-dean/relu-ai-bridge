#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {ensureCodexRegistration} from '../../src/codex-registration.mjs';

async function main() {
  const [codexCli, nodePath] = process.argv.slice(2);
  if (!codexCli || !nodePath || process.argv.length !== 4) {
    throw new Error('Usage: register-codex.mjs CODEX_CLI PERFETTO_NODE');
  }
  const result = await ensureCodexRegistration({
    codexCli,
    nodePath,
    proxyPath: fileURLToPath(new URL('./codex-mcp-proxy.mjs', import.meta.url)),
  });
  process.stdout.write(result.restartRequired
    ? 'Codex MCP registered; restart Codex once to load relu-perfetto\n'
    : 'Codex MCP registration already matches relu-perfetto\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`RELU Codex registration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
