import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PNG } from 'pngjs';
import Crc from 'pngjs/lib/crc.js';
import { cropScreenshot, nativeResponse, anchorFacts } from '../src/drivers/native-tree.js';

const colors = {
  A: [255, 0, 0, 255], B: [0, 255, 0, 255], C: [0, 0, 255, 255],
  D: [255, 255, 0, 128], E: [255, 0, 255, 64], F: [0, 0, 0, 0],
};
// Independent literal expected grids. Source raster is always AB / CD / EF.
const grids = ['AB/CD/EF', 'BA/DC/FE', 'FE/DC/BA', 'EF/CD/AB',
  'ACE/BDF', 'ECA/FDB', 'FDB/ECA', 'BDF/ACE'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function raster() {
  const image = new PNG({ width: 2, height: 3 });
  [...'ABCDEF'].forEach((letter, index) => image.data.set(colors[letter], index * 4));
  return PNG.sync.write(image);
}
function tiff(orientation, little = false) {
  const result = Buffer.alloc(26);
  result.write(little ? 'II' : 'MM', 0, 'ascii');
  const short = (offset, value) => result[little ? 'writeUInt16LE' : 'writeUInt16BE'](value, offset);
  const long = (offset, value) => result[little ? 'writeUInt32LE' : 'writeUInt32BE'](value, offset);
  short(2, 42); long(4, 8); short(8, 1);
  short(10, 0x112); short(12, 3); long(14, 1); short(18, orientation);
  return result;
}
function chunk(type, value) {
  const name = Buffer.from(type), header = Buffer.alloc(8), crc = Buffer.alloc(4);
  header.writeUInt32BE(value.length); name.copy(header, 4);
  // Independent fixture CRC from the existing PNG codec, not the production orientation parser.
  crc.writeInt32BE(Crc.crc32(Buffer.concat([name, value])));
  return Buffer.concat([header, value, crc]);
}
function withExif(data, ...metadata) {
  return Buffer.concat([data.subarray(0, 33), ...metadata.map(value => chunk('eXIf', value)), data.subarray(33)]);
}
function expected(grid) {
  return [...grid.replaceAll('/', '')].flatMap(letter => colors[letter]);
}
function response(data, width = 2, height = 3) {
  const raw = { status: 'PASS', keyboardVisible: false,
    tree: { type: 'application', frame: { x: 0, y: 0, width, height }, children: [
      { type: 'other', identifier: 'screen', frame: { x: 0, y: 0, width, height } },
    ] } };
  return nativeResponse(raw, data, { screen: 'screen', anchors: ['screen'], frame: 'device' });
}
function metadataRefused(metadata) {
  const result = response(withExif(raster(), metadata));
  assert.equal(result.response.status, 'NOT_RUN');
  assert.match(result.response.reason, /PNG_ORIENTATION_METADATA/);
  assert.equal(result.png, undefined);
}

for (const little of [false, true]) for (let orientation = 1; orientation <= 8; orientation++) {
  test('PNG eXIf ' + (little ? 'II' : 'MM') + ' orientation ' + orientation + ' matches literal RGBA grid', () => {
    const rows = grids[orientation - 1].split('/');
    const png = withExif(raster(), tiff(orientation, little)), before = sha(png);
    const result = cropScreenshot(png, { x: 0, y: 0, width: rows[0].length, height: rows.length }, rows[0].length);
    const actual = PNG.sync.read(result.png);
    assert.deepEqual([actual.width, actual.height, result.scale], [rows[0].length, rows.length, 1]);
    assert.deepEqual([...actual.data], expected(grids[orientation - 1]));
    assert.equal(sha(png), before, 'raw tagged PNG is immutable');
  });
}

test('no eXIf, identity and valid metadata without orientation keep the existing raster', () => {
  const absent = tiff(1); absent.writeUInt16BE(0x10e, 10); // A different IFD0 tag is not an orientation.
  for (const png of [raster(), withExif(raster(), tiff(1)), withExif(raster(), absent)]) {
    const result = cropScreenshot(png, { x: 0, y: 0, width: 2, height: 3 }, 2);
    assert.deepEqual([...PNG.sync.read(result.png).data], expected(grids[0]));
    assert.equal(result.scale, 1);
  }
});

test('orientation precedes scale and right/bottom crop clipping; alpha bytes are preserved', () => {
  const result = cropScreenshot(withExif(raster(), tiff(8)), { x: 1, y: 0, width: 2, height: 2 }, 1.5);
  const png = PNG.sync.read(result.png);
  assert.equal(result.scale, 2);
  assert.deepEqual([png.width, png.height], [1, 2]);
  assert.deepEqual([...png.data], [...colors.F, ...colors.E]);
});

test('native response retains anchor facts/bounds and applies only raster orientation', () => {
  const raw = { status: 'PASS', keyboardVisible: false,
    tree: { type: 'application', frame: { x: 0, y: 0, width: 3, height: 2 }, children: [
      { type: 'button', identifier: 'screen.go', label: 'Go', frame: { x: 1, y: 0, width: 1, height: 1 } },
    ] } };
  const before = JSON.stringify(raw);
  const options = { screen: 'screen', anchors: ['screen.go'], frame: 'device' };
  const result = nativeResponse(raw, withExif(raster(), tiff(8)), options);
  assert.equal(result.response.status, 'PASS');
  assert.deepEqual(result.response.viewport, { width: 3, height: 2, scale: 1 });
  assert.deepEqual(result.response.elements, anchorFacts(raw.tree, { ...options, content: { x: 0, y: 0, width: 3, height: 2 } }).elements);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual([...PNG.sync.read(result.png).data], expected(grids[7]));
});

test('missing orientation never guesses a quarter turn from application geometry', () => {
  const result = response(raster(), 3, 2);
  assert.equal(result.response.status, 'PASS');
  assert.equal(result.response.viewport.scale, 0.67, 'preserve the existing 3-argument crop contract; no inferred rotation or scale target');
  assert.deepEqual([PNG.sync.read(result.png).width, PNG.sync.read(result.png).height], [2, 1]);
});

for (const orientation of [0, 9, 65535]) test('out-of-range orientation ' + orientation + ' is NOT_RUN', () => metadataRefused(tiff(orientation)));
for (const [name, mutate] of [
  ['invalid byte order', value => value.write('ZZ', 0)],
  ['non-ASCII byte order is not a masked ASCII alias', value => value.writeUInt8(0xcd, 0)],
  ['unsupported TIFF magic', value => value.writeUInt16BE(43, 2)],
  ['IFD0 offset outside metadata', value => value.writeUInt32BE(5000, 4)],
  ['IFD0 overlaps TIFF header', value => value.writeUInt32BE(2, 4)],
  ['IFD entries overflow metadata', value => value.writeUInt16BE(65535, 8)],
  ['orientation is not SHORT', value => value.writeUInt16BE(4, 12)],
  ['orientation count is not one', value => value.writeUInt32BE(2, 14)],
]) test(name + ' is NOT_RUN', () => { const value = tiff(8); mutate(value); metadataRefused(value); });

test('truncated eXIf TIFF header is NOT_RUN', () => metadataRefused(Buffer.from('MM')));
test('truncated TIFF IFD0/next-pointer is NOT_RUN', () => metadataRefused(tiff(8).subarray(0, 23)));
test('duplicate IFD0 orientation tags are NOT_RUN even if they agree', () => {
  const value = Buffer.alloc(38); tiff(8).subarray(0, 22).copy(value);
  value.writeUInt16BE(2, 8); value.copy(value, 22, 10, 22);
  metadataRefused(value);
});
test('multiple eXIf chunks are NOT_RUN even if they agree', () => {
  const result = response(withExif(raster(), tiff(8), tiff(8)));
  assert.equal(result.response.status, 'NOT_RUN'); assert.equal(result.png, undefined);
});
test('eXIf CRC is verified despite the codec skipping unknown ancillary CRCs', () => {
  const png = withExif(raster(), tiff(8));
  png[33 + 8 + 26] ^= 1;
  const result = response(png);
  assert.equal(result.response.status, 'NOT_RUN'); assert.equal(result.png, undefined);
});
test('declared eXIf chunk overflow is a known metadata failure', () => {
  const png = withExif(raster(), tiff(8)); png.writeUInt32BE(0xffffffff, 33);
  const result = response(png);
  assert.equal(result.response.status, 'NOT_RUN'); assert.equal(result.png, undefined);
});
test('unrelated unknown ancillary chunks are left to the existing PNG decoder', () => {
  const png = Buffer.concat([raster().subarray(0, 33), chunk('vpAg', Buffer.from('unchanged')), raster().subarray(33)]);
  assert.deepEqual([...PNG.sync.read(cropScreenshot(png, { x: 0, y: 0, width: 2, height: 3 }, 2).png).data], expected(grids[0]));
});
test('unknown decoder/programming errors are not swallowed as orientation NOT_RUN', () => {
  assert.throws(() => response(Buffer.from('not a PNG')));
});

const diagnostic = process.env.PROTOFLOW_PNG_ORIENTATION_DIAGNOSTIC;
test('recorded tagged full-screen screenshot uses its metadata without changing raw evidence', {
  skip: diagnostic ? false : 'NOT_RUN: external private diagnostic capture not supplied',
}, async () => {
  const original = await readFile(path.join(diagnostic, 'device.png')), before = sha(original);
  assert.equal(before, '7b98fc79d546781eac4274d350430f09f911b6e2e8428c33396e5d2a2607490b');
  const raw = JSON.parse(await readFile(path.join(diagnostic, 'raw.json'), 'utf8'));
  const frame = JSON.parse(await readFile(path.join(diagnostic, 'app-window-frame.json'), 'utf8'));
  const rawBefore = JSON.stringify(raw);
  const result = nativeResponse({ ...raw, safeArea: frame.content }, original,
    { screen: 'ai.home', anchors: ['ai.home'], frame: 'safe-area' });
  assert.equal(result.response.status, 'PASS');
  assert.deepEqual(result.response.viewport, { width: 1210, height: 782, scale: 2 });
  const image = PNG.sync.read(result.png), source = PNG.sync.read(original);
  assert.deepEqual([image.width, image.height], [2420, 1564]);
  // Fixed expected source coordinates for this independently recorded Orientation=8 fixture.
  for (const [outX, outY, rawX, rawY] of [[0, 0, 1603, 0], [2419, 0, 1603, 2419],
    [0, 1563, 40, 0], [2419, 1563, 40, 2419]]) {
    const a = (outY * image.width + outX) * 4, b = (rawY * source.width + rawX) * 4;
    assert.deepEqual(image.data.subarray(a, a + 4), source.data.subarray(b, b + 4));
  }
  assert.equal(JSON.stringify(raw), rawBefore);
  assert.equal(sha(await readFile(path.join(diagnostic, 'device.png'))), before);
});
