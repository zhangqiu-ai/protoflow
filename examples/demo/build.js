import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

for (const [file, required] of [
  ['prototype/index.html', ['id="card"', 'id="heading"', 'id="name"', 'id="create"']],
  ['app/index.html', ['data-ui="card"', 'data-ui="heading"', 'id="session-name"', 'data-ui="create"']],
]) {
  const html = await readFile(new URL(file, import.meta.url), 'utf8');
  if (!html.toLowerCase().startsWith('<!doctype html>')) throw new Error(`Missing document declaration: ${file}`);
  for (const region of required) if (!html.includes(region)) throw new Error(`Missing required region ${region}: ${file}`);
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1], { filename: file });
}
console.log('Demo documents, mapped regions and browser scripts are valid.');
