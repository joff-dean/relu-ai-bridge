#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {brotliCompress, constants as zlibConstants} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const compress = promisify(brotliCompress);
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const INSTALLER_PROJECT = path.join(PROJECT_ROOT, 'sdk-dotnet', 'src',
  'Relu.AI.Bridge.PerfettoInstaller', 'Relu.AI.Bridge.PerfettoInstaller.csproj');
const HOST_PROJECT = path.join(PROJECT_ROOT, 'sdk-dotnet', 'src',
  'Relu.AI.Bridge.PerfettoNativeHost', 'Relu.AI.Bridge.PerfettoNativeHost.csproj');
const FOOTER_MAGIC = Buffer.from('RELU-PERFETTO-V1', 'ascii');
const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const EXTENSION_ID = /^[a-p]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function exactHttpOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('origin must be an exact HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value
      || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('origin must be an exact HTTP(S) origin');
  }
  return parsed.origin;
}

function exactHttpsUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('extension-update-url must be an HTTPS URL'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error('extension-update-url must be an HTTPS URL without credentials or fragment');
  }
  return parsed.href;
}

function positivePort(value) {
  if (!/^[1-9][0-9]{0,4}$/u.test(value ?? '')) throw new Error('bridge-port is invalid');
  const port = Number(value);
  if (port > 65_535) throw new Error('bridge-port is invalid');
  return port;
}

export function parseWindowsInstallerArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || value === undefined || values.has(option)) {
      throw new Error(`invalid or duplicate option: ${option ?? '(missing)'}`);
    }
    values.set(option, value);
  }
  const allowed = new Set([
    '--origin', '--extension-id', '--extension-update-url', '--bridge-port', '--node-exe',
    '--node-sha256', '--output', '--runtime-id', '--dotnet',
  ]);
  for (const option of values.keys()) {
    if (!allowed.has(option)) throw new Error(`unsupported option: ${option}`);
  }
  for (const required of [
    '--origin', '--extension-id', '--extension-update-url', '--node-exe', '--node-sha256', '--output',
  ]) {
    if (!values.has(required)) throw new Error(`${required} is required`);
  }
  const extensionId = values.get('--extension-id');
  const nodeSha256 = values.get('--node-sha256');
  const runtimeId = values.get('--runtime-id') ?? 'win-x64';
  if (!EXTENSION_ID.test(extensionId)) throw new Error('extension-id is invalid');
  if (!SHA256.test(nodeSha256)) throw new Error('node-sha256 is invalid');
  if (!['win-x64', 'win-arm64'].includes(runtimeId)) throw new Error('runtime-id must be win-x64 or win-arm64');
  const nodeExe = path.resolve(values.get('--node-exe'));
  const output = path.resolve(values.get('--output'));
  if (output === PROJECT_ROOT || output.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new Error('output must be outside the source repository');
  }
  if (path.extname(output).toLowerCase() !== '.exe') throw new Error('output must end in .exe');
  return Object.freeze({
    origin: exactHttpOrigin(values.get('--origin')),
    extensionId,
    extensionUpdateUrl: exactHttpsUrl(values.get('--extension-update-url')),
    bridgePort: positivePort(values.get('--bridge-port') ?? '5746'),
    nodeExe,
    nodeSha256,
    output,
    runtimeId,
    dotnet: values.get('--dotnet') ? path.resolve(values.get('--dotnet')) : 'dotnet',
  });
}

async function sha256File(file) {
  const handle = await fs.open(file, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(128 * 1024);
    while (true) {
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function verifyWindowsPe(file, runtimeId) {
  const status = await fs.lstat(file);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 512 || status.size > MAX_FILE_BYTES) {
    throw new Error(`Windows runtime input is not a bounded regular file: ${file}`);
  }
  const handle = await fs.open(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length
        || dos[0] !== 0x4d || dos[1] !== 0x5a) {
      throw new Error(`Windows runtime input does not have an MZ header: ${file}`);
    }
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > Math.min(status.size - 6, 1024 * 1024)) {
      throw new Error(`Windows runtime input has an invalid PE offset: ${file}`);
    }
    const pe = Buffer.alloc(6);
    if ((await handle.read(pe, 0, pe.length, peOffset)).bytesRead !== pe.length
        || pe.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`Windows runtime input does not have a PE signature: ${file}`);
    }
    const expectedMachine = runtimeId === 'win-x64' ? 0x8664 : 0xaa64;
    if (pe.readUInt16LE(4) !== expectedMachine) {
      throw new Error(`Windows runtime input architecture does not match ${runtimeId}: ${file}`);
    }
  } finally {
    await handle.close();
  }
}

async function run(executable, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? PROJECT_ROOT,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} failed (${signal ?? code})`));
    });
  });
}

async function collectTree(root, prefix, {include = () => true} = {}) {
  const result = [];
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, {withFileTypes: true});
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`payload source symlink is not allowed: ${source}`);
      if (entry.isDirectory()) await visit(source, next);
      else if (entry.isFile() && include(next)) result.push({source, path: `${prefix}/${next}`});
      else if (!entry.isFile()) throw new Error(`payload source must be a regular file: ${source}`);
    }
  }
  await visit(root);
  return result;
}

function validatePayloadPath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._/-]{1,240}$/u.test(value)
      || value.startsWith('/') || value.endsWith('/') || value.includes('\\')) {
    throw new Error(`unsafe payload path: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`unsafe payload path: ${value}`);
  }
  return value;
}

async function payloadSources(nativeHostPath, nodeExe) {
  const sources = [
    {source: nativeHostPath, path: 'Relu.AI.Bridge.PerfettoNativeHost.exe'},
    {source: nodeExe, path: 'runtime/node.exe'},
    {source: path.join(PROJECT_ROOT, 'scripts/perfetto/run-extension-bridge.mjs'), path: 'app/scripts/perfetto/run-extension-bridge.mjs'},
    {source: path.join(PROJECT_ROOT, 'scripts/perfetto/desktop-mcp-proxy.mjs'), path: 'app/scripts/perfetto/desktop-mcp-proxy.mjs'},
    {source: path.join(PROJECT_ROOT, 'scripts/skills/manage-skills.mjs'), path: 'app/scripts/skills/manage-skills.mjs'},
  ];
  sources.push(...await collectTree(path.join(PROJECT_ROOT, 'src'), 'app/src', {
    include: (relative) => relative.endsWith('.mjs'),
  }));
  sources.push(...await collectTree(path.join(PROJECT_ROOT, 'alignment'), 'app/alignment', {
    include: (relative) => relative.endsWith('.mjs') && !relative.startsWith('test/'),
  }));
  for (const name of ['admin.html', 'admin.js', 'admin.css']) {
    sources.push({source: path.join(PROJECT_ROOT, 'web', name), path: `app/web/${name}`});
  }
  sources.push(...await collectTree(path.join(PROJECT_ROOT, 'skills'), 'app/skills'));
  const seen = new Set();
  for (const item of sources) {
    validatePayloadPath(item.path);
    const folded = item.path.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new Error(`duplicate payload path: ${item.path}`);
    seen.add(folded);
    const status = await fs.lstat(item.source);
    if (!status.isFile() || status.isSymbolicLink() || status.size < 1 || status.size > MAX_FILE_BYTES) {
      throw new Error(`invalid payload source: ${item.source}`);
    }
  }
  return sources.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export async function appendInstallerBundle({stub, files, contract, output}) {
  const compressed = [];
  const records = [];
  const payloadHash = crypto.createHash('sha256');
  let payloadBytes = 0;
  const seenPaths = new Set();
  for (const file of files) {
    validatePayloadPath(file.path);
    const folded = file.path.toLocaleLowerCase('en-US');
    if (seenPaths.has(folded)) throw new Error(`duplicate payload path: ${file.path}`);
    seenPaths.add(folded);
    const source = await fs.readFile(file.source);
    if (source.length < 1 || source.length > MAX_FILE_BYTES) throw new Error(`payload file size is invalid: ${file.path}`);
    const archive = await compress(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    });
    if (archive.length < 1 || archive.length > MAX_FILE_BYTES) throw new Error(`compressed file size is invalid: ${file.path}`);
    records.push({
      path: file.path,
      offset: payloadBytes,
      compressedBytes: archive.length,
      bytes: source.length,
      sha256: crypto.createHash('sha256').update(source).digest('hex'),
    });
    compressed.push(archive);
    payloadHash.update(archive);
    payloadBytes += archive.length;
    if (payloadBytes > MAX_PAYLOAD_BYTES) throw new Error('installer payload exceeds the size limit');
  }
  const completeContract = {
    schemaVersion: 1,
    ...contract,
    payloadBytes,
    payloadSha256: payloadHash.digest('hex'),
    files: records,
  };
  const contractBytes = Buffer.from(`${JSON.stringify(completeContract)}\n`, 'utf8');
  if (contractBytes.length > 1024 * 1024) throw new Error('installer contract exceeds the size limit');
  const footer = Buffer.alloc(28);
  footer.writeBigInt64LE(BigInt(payloadBytes), 0);
  footer.writeInt32LE(contractBytes.length, 8);
  FOOTER_MAGIC.copy(footer, 12);

  const destination = await fs.open(output, 'wx', 0o700);
  try {
    await destination.write(await fs.readFile(stub));
    for (const archive of compressed) await destination.write(archive);
    await destination.write(contractBytes);
    await destination.write(footer);
    await destination.sync();
  } catch (error) {
    await destination.close().catch(() => {});
    await fs.rm(output, {force: true}).catch(() => {});
    throw error;
  }
  await destination.close();
  return completeContract;
}

export async function buildWindowsInstaller(options) {
  await verifyWindowsPe(options.nodeExe, options.runtimeId);
  const actualNodeSha256 = await sha256File(options.nodeExe);
  if (actualNodeSha256 !== options.nodeSha256) throw new Error('node.exe SHA-256 does not match --node-sha256');
  if (path.isAbsolute(options.dotnet)) await fs.access(options.dotnet);
  await fs.access(path.dirname(options.output));
  await fs.access(options.output).then(
    () => { throw new Error('output already exists'); },
    (error) => { if (error?.code !== 'ENOENT') throw error; },
  );
  await run(process.execPath, [path.join(PROJECT_ROOT, 'scripts/skills/manage-skills.mjs'), 'verify-source']);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relu-perfetto-installer-'));
  try {
    const hostOutput = path.join(temporary, 'host');
    const installerOutput = path.join(temporary, 'installer');
    const publish = (project, output) => run(options.dotnet, [
      'publish', project, '-c', 'Release', '-r', options.runtimeId, '--self-contained', 'true',
      '-o', output, '/p:PublishSingleFile=true', '/p:PublishTrimmed=false',
      '/p:IncludeNativeLibrariesForSelfExtract=true', '/p:DebugType=None', '/p:DebugSymbols=false',
    ]);
    await publish(HOST_PROJECT, hostOutput);
    await publish(INSTALLER_PROJECT, installerOutput);
    const nativeHost = path.join(hostOutput, 'Relu.AI.Bridge.PerfettoNativeHost.exe');
    const stub = path.join(installerOutput, 'RELU-Perfetto-Setup.exe');
    const files = await payloadSources(nativeHost, options.nodeExe);
    const packageJson = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const contract = await appendInstallerBundle({
      stub,
      files,
      output: options.output,
      contract: {
        product: 'relu-perfetto-connector',
        productVersion: packageJson.version,
        runtimeIdentifier: options.runtimeId,
        extensionId: options.extensionId,
        perfettoOrigin: options.origin,
        extensionUpdateUrl: options.extensionUpdateUrl,
        bridgePort: options.bridgePort,
      },
    });
    process.stdout.write(`${JSON.stringify({
      output: options.output,
      sha256: await sha256File(options.output),
      payloadSha256: contract.payloadSha256,
      files: contract.files.length,
      unsigned: true,
    })}\n`);
  } finally {
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  buildWindowsInstaller(parseWindowsInstallerArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`RELU Perfetto Windows installer build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
