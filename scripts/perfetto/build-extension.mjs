#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const SOURCE = fileURLToPath(new URL('../../perfetto-extension/', import.meta.url));
const FILES = ['background.js', 'content.js'];

export function parseBuildExtensionArgs(argv) {
  let origin;
  let output;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${name ?? 'option'} requires a value`);
    if (name === '--origin') origin = exactHttpOrigin(value);
    else if (name === '--output') output = path.resolve(value);
    else throw new Error(`Unsupported option: ${name}`);
  }
  if (!origin || !output) throw new Error('Usage: build-extension.mjs --origin HTTPS_ORIGIN --output NEW_DIRECTORY');
  if (output === SOURCE || output.startsWith(`${SOURCE}${path.sep}`)) throw new Error('Output must be outside the extension source');
  return {origin, output};
}

function exactHttpOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('origin must be an exact HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value
      || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('origin must be an exact HTTP(S) origin');
  }
  return parsed.origin;
}

export async function buildPerfettoExtension(options) {
  try {
    await fs.mkdir(options.output, {recursive: false, mode: 0o700});
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Output directory already exists');
    throw error;
  }
  try {
    const sourceManifest = JSON.parse(await fs.readFile(path.join(SOURCE, 'manifest.json'), 'utf8'));
    const manifest = {
      ...sourceManifest,
      content_scripts: sourceManifest.content_scripts.map((entry) => ({...entry, matches: [`${options.origin}/*`]})),
    };
    await fs.writeFile(path.join(options.output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    await fs.writeFile(path.join(options.output, 'policy.js'),
      `export const PERFETTO_ORIGIN = ${JSON.stringify(options.origin)};\n` +
      "export const NATIVE_HOST_NAME = 'com.relu_ai_bridge.perfetto';\n" +
      'export const EXTENSION_PROTOCOL_VERSION = 1;\n' +
      'export const MAX_BRIDGE_MESSAGE_CHARS = 1_048_576;\n',
      {mode: 0o600, flag: 'wx'});
    for (const file of FILES) {
      await fs.copyFile(path.join(SOURCE, file), path.join(options.output, file), fs.constants.COPYFILE_EXCL);
    }
  } catch (error) {
    await fs.rm(options.output, {recursive: true, force: true});
    throw error;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  buildPerfettoExtension(parseBuildExtensionArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`RELU Perfetto Extension build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
