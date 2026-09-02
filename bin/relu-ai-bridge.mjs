#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialConfig, loadConfig } from '../src/config.mjs';
import { archiveOperationLedger } from '../src/ledger-maintenance.mjs';
import { startServer } from '../src/server.mjs';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function usage(command = null) {
  const lines = command === 'init'
    ? [
      'Usage: relu-ai-bridge init [--] [CONFIG_PATH] [PROJECT_ROOT]',
      'Creates a read-only starter configuration and prints new audience-specific tokens once.',
    ]
    : command === 'serve'
      ? ['Usage: relu-ai-bridge serve']
      : command === 'doctor'
        ? ['Usage: relu-ai-bridge doctor']
        : command === 'archive-ledger'
          ? [
            'Usage: relu-ai-bridge archive-ledger',
            'Offline only: archives a terminal operation ledger after policyEpoch is increased.',
          ]
          : [
            'Usage: relu-ai-bridge <serve|init|doctor|archive-ledger> [arguments]',
            'Run relu-ai-bridge <command> --help for command-specific help.',
          ];
  return `${lines.join('\n')}\n`;
}

function commandArguments(values, maximum) {
  const separator = values.indexOf('--');
  if (separator > 0 || (separator === 0 && values.slice(1).includes('--'))) return null;
  const args = separator === 0 ? values.slice(1) : values;
  if (separator < 0 && args.some((value) => value.startsWith('-'))) return null;
  if (args.length > maximum) return null;
  return args;
}

async function main() {
  const command = process.argv[2] ?? 'serve';
  const rawArguments = process.argv.slice(3);
  if (['-h', '--help'].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  if (['-h', '--help'].includes(rawArguments[0]) && rawArguments.length === 1
    && ['serve', 'init', 'doctor', 'archive-ledger'].includes(command)) {
    process.stdout.write(usage(command));
    return;
  }
  if (command === 'serve') {
    if (!commandArguments(rawArguments, 0)) {
      process.stderr.write(usage('serve'));
      process.exitCode = 2;
      return;
    }
    await startServer();
    return;
  }
  if (command === 'init') {
    const args = commandArguments(rawArguments, 2);
    if (!args) {
      process.stderr.write(usage('init'));
      process.exitCode = 2;
      return;
    }
    const target = args[0] ?? path.join(process.cwd(), 'config', 'local.json');
    const projectRoot = args[1] ?? process.cwd();
    const result = await createInitialConfig(target, projectRoot);
    process.stdout.write(`Created ${result.configPath}\n`);
    process.stdout.write('Store these audience-specific tokens in your company secret manager; they are shown only once:\n');
    process.stdout.write(`Control/MCP: ${result.token}\n`);
    process.stdout.write(`Perfetto connector: ${result.perfettoToken}\n\n`);
    const executable = fileURLToPath(import.meta.url);
    process.stdout.write(`Start with:\nRELU_AI_BRIDGE_CONFIG=${shellQuote(result.configPath)} RELU_AI_BRIDGE_TOKEN='<control-token>' RELU_PERFETTO_CONNECTOR_TOKEN='<perfetto-token>' ${shellQuote(process.execPath)} ${shellQuote(executable)} serve\n`);
    return;
  }
  if (command === 'doctor') {
    if (!commandArguments(rawArguments, 0)) {
      process.stderr.write(usage('doctor'));
      process.exitCode = 2;
      return;
    }
    const config = await loadConfig();
    const checks = [];
    checks.push(['config', config.configPath, 'ok']);
    for (const root of config.roots) {
      const stat = await fs.stat(root.path);
      checks.push([`root:${root.id}`, root.path, stat.isDirectory() ? 'ok' : 'invalid']);
    }
    for (const [name, profile] of Object.entries(config.commandProfiles)) {
      checks.push([`command:${name}`, `${profile.program} ${(profile.args ?? []).join(' ')}`, 'configured']);
    }
    checks.push(['authentication', config.server.auth, 'token loaded']);
    checks.push(['MCP authentication', config.server.mcpAuth, 'enabled']);
    checks.push(['approval policy', config.approvals.policy, config.approvals.policy === 'trusted_always' ? 'automatic' : 'interactive']);
    checks.push(['persistent manual grants', String(config.approvals.allowPersistentGrants), config.approvals.policy === 'manual' ? 'available' : 'inactive']);
    checks.push(['Perfetto WebSocket', config.perfetto.websocketPath, config.perfetto.enabled ? 'enabled' : 'disabled']);
    for (const origin of config.perfetto.allowedOrigins) checks.push(['Perfetto origin', origin, 'allowed']);
    checks.push(['RELU connector WS', config.connectors.websocketPath, config.connectors.enabled ? 'enabled' : 'disabled']);
    for (const service of config.connectors.services) {
      checks.push([`connector:${service.id}`, service.displayName, `${service.capabilities.length} capabilities`]);
      for (const origin of service.origins) checks.push([`origin:${service.id}`, origin, 'allowed']);
    }
    for (const row of checks) process.stdout.write(`${row[2].padEnd(12)} ${row[0].padEnd(24)} ${row[1]}\n`);
    return;
  }
  if (command === 'archive-ledger') {
    if (!commandArguments(rawArguments, 0)) {
      process.stderr.write(usage('archive-ledger'));
      process.exitCode = 2;
      return;
    }
    const config = await loadConfig();
    const result = await archiveOperationLedger(config);
    process.stdout.write(`Archived ${result.recordCount} terminal operation records.\n`);
    process.stdout.write(`Policy epoch: ${result.fromPolicyEpoch} -> ${result.toPolicyEpoch}\n`);
    process.stdout.write(`Archive: ${result.archiveFile}\n`);
    process.stdout.write(`SHA-256: ${result.ledgerSha256}\n`);
    return;
  }
  process.stderr.write(usage());
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
  process.exitCode = 1;
});
