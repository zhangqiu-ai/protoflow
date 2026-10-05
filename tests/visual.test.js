import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { compareImages, verifyVisual } from '../src/visual.js';

const image = (red) => {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = red; png.data[i + 3] = 255; }
  return PNG.sync.write(png);
};

test('pixel evidence detects actual differences and retains comparison artifacts', () => {
  assert.equal(compareImages(image(0), image(0)).ratio, 0);
  const comparison = compareImages(image(0), image(255));
  assert.equal(comparison.ratio, 1);
  assert.equal(PNG.sync.read(comparison.sideBySide).width, 8);
  assert.equal(PNG.sync.read(comparison.overlay).data[0], 128);
});

test('unconfigured and native visual verification are explicitly NOT_RUN', async () => {
  assert.equal((await verifyVisual('.', {}, 'unused')).status, 'NOT_RUN');
  const result = await verifyVisual('.', { visual: { mode: 'native', scenes: [{ id: 'native' }] } }, 'unused');
  assert.equal(result.status, 'NOT_RUN');
  assert.match(result.reason, /Native UI/);
});
