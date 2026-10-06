import { readFile, readdir, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
let files = 0;
async function validateResource(from, relative) {
  const target = await realpath(path.resolve(path.dirname(from), relative));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Resource escapes example: ${relative}`);
  return target;
}
async function check(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) { await check(file); continue; }
    files++;
    const source = await readFile(file, 'utf8');
    if (file.endsWith('.js')) await exec(process.execPath, ['--check', file]);
    if (file.endsWith('.css') && source.split('{').length !== source.split('}').length) throw new Error(`Unbalanced CSS rules: ${file}`);
    if (file.endsWith('.html')) {
      if (!source.toLowerCase().startsWith('<!doctype html>')) throw new Error(`Missing document declaration: ${file}`);
      if (!source.includes('id="navigation"') || !source.includes(`id="${path.basename(file, '.html')}-panel"`)) throw new Error(`Missing mapped regions: ${file}`);
      for (const match of source.matchAll(/(?:href|src)="([^"]+)"/g)) await validateResource(file, match[1]);
      for (const match of source.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
        if (match[1].includes('type="module"')) {
          for (const imported of match[2].matchAll(/from\s+['"]([^'"]+)['"]/g)) await validateResource(file, imported[1]);
          new Script(match[2].replace(/import\s+[^;]+;/g, ''), { filename: file });
        } else new Script(match[2], { filename: file });
      }
    }
  }
}
await check(path.join(root, 'prototype'));
await check(path.join(root, 'app'));
console.log(`Modular build check passed: ${files} independent HTML, CSS and JavaScript files; linked resources and mapped regions exist.`);
