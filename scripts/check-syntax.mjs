import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const roots = ['src', 'bin', 'scripts', 'extension', 'alignment', 'sdk', 'examples'];
const ignored = new Set(['node_modules', '.git', 'dist']);

async function collect(directory, result = []) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target, result);
    else if (/\.(?:m?js|cjs)$/.test(entry.name)) result.push(target);
  }
  return result;
}

function check(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Syntax check failed for ${file} (${signal ?? code})`));
    });
  });
}

const files = [];
for (const root of roots) await collect(path.resolve(root), files);
for (const file of files.sort()) await check(file);
process.stdout.write(`Syntax OK: ${files.length} JavaScript files\n`);
