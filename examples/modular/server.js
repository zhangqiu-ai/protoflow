import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PROTOFLOW_MODULAR_PORT ?? process.env.PORT ?? 4319);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid modular server port');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const requested = pathname === '/' ? '/prototype/pages/chat.html' : pathname;
    const file = await realpath(path.resolve(root, `.${requested}`));
    if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end('Forbidden'); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  process.stdout.write(`ProtoFlow modular: http://127.0.0.1:${actualPort}\n`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
