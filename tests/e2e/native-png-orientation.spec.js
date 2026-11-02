import { test, expect, chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import Crc from 'pngjs/lib/crc.js';
import { cropScreenshot } from '../../src/drivers/native-tree.js';

// Protocol/codec guard only. No native App, Simulator, device capture or provider is used.
test('native PNG orientation offline regression suite retains exact crops and rejects invalid metadata', () => {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
    fileURLToPath(new URL('../png-orientation.test.js', import.meta.url))],
  { encoding: 'utf8', timeout: 30_000, env: { ...process.env } });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toMatch(/# fail 0\b/);
  expect(result.stdout).toMatch(/# pass [1-9]/);
});

test.describe('independent browser interpretation of standard eXIf orientations', () => {
  test.skip(!existsSync(chromium.executablePath()), 'NOT_RUN: existing Chromium is unavailable; do not install for this guard');
  test('Chromium img/canvas and the native PNG pipeline agree with eight literal non-square RGBA grids', async ({ page }) => {
    const colors = {
      A: [255, 0, 0, 255], B: [0, 255, 0, 255], C: [0, 0, 255, 255],
      D: [255, 255, 0, 128], E: [255, 0, 255, 64], F: [0, 0, 0, 0],
    };
    const grids = ['AB/CD/EF', 'BA/DC/FE', 'FE/DC/BA', 'EF/CD/AB',
      'ACE/BDF', 'ECA/FDB', 'FDB/ECA', 'BDF/ACE'];
    for (const little of [false, true]) for (let orientation = 1; orientation <= 8; orientation++) {
      await test.step((little ? 'II' : 'MM') + ' orientation ' + orientation, async () => {
        const image = new PNG({ width: 2, height: 3 });
        [...'ABCDEF'].forEach((letter, index) => image.data.set(colors[letter], index * 4));
        const png = PNG.sync.write(image), tiff = Buffer.alloc(26);
        tiff.write(little ? 'II' : 'MM');
        const short = (offset, value) => tiff[little ? 'writeUInt16LE' : 'writeUInt16BE'](value, offset);
        const long = (offset, value) => tiff[little ? 'writeUInt32LE' : 'writeUInt32BE'](value, offset);
        short(2, 42); long(4, 8); short(8, 1); short(10, 0x112);
        short(12, 3); long(14, 1); short(18, orientation);
        const chunk = Buffer.alloc(38);
        chunk.writeUInt32BE(26); chunk.write('eXIf', 4); tiff.copy(chunk, 8);
        chunk.writeInt32BE(Crc.crc32(chunk.subarray(4, 34)), 34);
        const tagged = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
        const rows = grids[orientation - 1].split('/');
        const expected = [...grids[orientation - 1].replaceAll('/', '')].flatMap(letter => colors[letter]);
        const decoded = await page.evaluate(async source => {
          const image = new Image(); image.src = source; await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          return { width: canvas.width, height: canvas.height,
            pixels: [...context.getImageData(0, 0, canvas.width, canvas.height).data] };
        }, 'data:image/png;base64,' + tagged.toString('base64'));
        expect([decoded.width, decoded.height]).toEqual([rows[0].length, rows.length]);
        expect(decoded.pixels).toEqual(expected);
        const output = PNG.sync.read(cropScreenshot(tagged,
          { x: 0, y: 0, width: rows[0].length, height: rows.length }, rows[0].length).png);
        expect([output.width, output.height]).toEqual([decoded.width, decoded.height]);
        expect([...output.data]).toEqual(decoded.pixels);
      });
    }
  });
});
