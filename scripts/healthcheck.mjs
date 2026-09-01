#!/usr/bin/env node
const url = process.argv[2] ?? 'http://127.0.0.1:5746/health';
const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error(`Health check failed with HTTP ${response.status}`);
process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
