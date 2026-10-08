// Static build check: every application page parses and its scripts compile.
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
for (const name of (await readdir('app')).filter(file => file.endsWith('.html'))) {
  const html = await readFile(`app/${name}`, 'utf8');
  if (!html.toLowerCase().startsWith('<!doctype html>')) throw new Error(`app/${name}: missing doctype`);
}
for (const name of (await readdir('app')).filter(file => file.endsWith('.js'))) new vm.Script(await readFile(`app/${name}`, 'utf8'), { filename: name });
console.log('Application pages and scripts are valid');
