#!/usr/bin/env node

import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {
  assertPerfettoRuntimeOwner,
  readPerfettoRuntime,
} from '../../src/perfetto-codex-runtime.mjs';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 65_000;
const HEALTH_TIMEOUT_MS = 2_000;

async function readBoundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('MCP response exceeded the local size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((item) => Buffer.from(item)), size).toString('utf8');
}

async function verifyBridge(runtime, fetchImpl) {
  assertPerfettoRuntimeOwner(runtime);
  const endpoint = new URL(runtime.bridgeUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${endpoint.origin}/health`, {
      method: 'GET',
      headers: {accept: 'application/json'},
      redirect: 'error',
      signal: controller.signal,
    });
    const body = await readBoundedBody(response);
    const health = response.ok ? JSON.parse(body) : null;
    if (
      health?.ok !== true
      || health.name !== 'relu-ai-bridge'
      || health.version !== runtime.bridgeVersion
      || health.mcpAuth !== 'bearer'
    ) {
      throw new Error('The live loopback service is not the expected RELU AI Bridge');
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function createCodexMcpRelay({runtimeFile, fetchImpl = fetch} = {}) {
  const runtime = await readPerfettoRuntime(runtimeFile);
  await verifyBridge(runtime, fetchImpl);
  let sessionId = null;

  async function request(message) {
    assertPerfettoRuntimeOwner(runtime);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(runtime.bridgeUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${runtime.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'mcp-protocol-version': '2025-06-18',
          ...(sessionId ? {'mcp-session-id': sessionId} : {}),
        },
        body: JSON.stringify(message),
        redirect: 'error',
        signal: controller.signal,
      });
      const nextSessionId = response.headers.get('mcp-session-id');
      if (nextSessionId) sessionId = nextSessionId;
      if (response.status === 202) return null;
      const body = await readBoundedBody(response);
      if (!response.ok) throw new Error(`RELU MCP request failed with HTTP ${response.status}`);
      return JSON.parse(body);
    } finally {
      clearTimeout(timer);
    }
  }

  async function close() {
    if (!sessionId) return;
    const closingSession = sessionId;
    sessionId = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    timer.unref?.();
    try {
      await fetchImpl(runtime.bridgeUrl, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${runtime.token}`,
          'mcp-session-id': closingSession,
        },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      // Process shutdown is best-effort; the server also expires idle sessions.
    } finally {
      clearTimeout(timer);
    }
  }

  return {request, close};
}

function protocolError(id, message) {
  return {jsonrpc: '2.0', id: id ?? null, error: {code: -32603, message}};
}

export async function runCodexMcpProxy({input = process.stdin, output = process.stdout, error = process.stderr} = {}) {
  const relay = await createCodexMcpRelay();
  let buffered = Buffer.alloc(0);
  let chain = Promise.resolve();
  let closed = false;

  const consume = (line) => {
    if (line.length === 0) return;
    chain = chain.then(async () => {
      let message;
      try {
        message = JSON.parse(line.toString('utf8'));
        const response = await relay.request(message);
        if (response !== null) output.write(`${JSON.stringify(response)}\n`);
      } catch (failure) {
        output.write(`${JSON.stringify(protocolError(message?.id, failure.message))}\n`);
      }
    });
  };

  input.on('data', (chunk) => {
    if (closed) return;
    buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (buffered.length > MAX_INPUT_BYTES) {
      closed = true;
      error.write('RELU Codex MCP input exceeded the local size limit\n');
      input.destroy();
      return;
    }
    let newline;
    while ((newline = buffered.indexOf(0x0a)) >= 0) {
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      consume(line);
    }
  });
  await new Promise((resolve, reject) => {
    input.once('end', resolve);
    input.once('close', resolve);
    input.once('error', reject);
  });
  if (!closed && buffered.length > 0) consume(buffered);
  await chain;
  await relay.close();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runCodexMcpProxy().catch((failure) => {
    process.stderr.write(`RELU Codex MCP proxy failed: ${failure.message}\n`);
    process.exitCode = 1;
  });
}
