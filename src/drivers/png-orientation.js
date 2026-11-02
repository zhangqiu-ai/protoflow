import { PNG } from 'pngjs';

export class PngOrientationError extends Error {
  constructor(reason) {
    super('PNG_ORIENTATION_METADATA: ' + reason);
    this.name = 'PngOrientationError';
    this.code = 'PNG_ORIENTATION_METADATA';
  }
}
const invalid = reason => { throw new PngOrientationError(reason); };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// pngjs skips CRC validation for unknown ancillary chunks, including eXIf. Validate the metadata we trust.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function tiffOrientation(bytes) {
  if (bytes.length < 8) invalid('truncated TIFF header');
  const order = bytes.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') invalid('unsupported TIFF byte order');
  const short = offset => bytes[order === 'II' ? 'readUInt16LE' : 'readUInt16BE'](offset);
  const long = offset => bytes[order === 'II' ? 'readUInt32LE' : 'readUInt32BE'](offset);
  if (short(2) !== 42) invalid('unsupported TIFF format');
  const offset = long(4);
  if (offset < 8 || offset + 2 > bytes.length) invalid('IFD0 offset is outside TIFF metadata');
  const count = short(offset);
  // IFD0 is bounded by its 16-bit entry count and the eXIf chunk. Do not follow thumbnail or sub-IFD pointers.
  if (offset + 2 + count * 12 + 4 > bytes.length) invalid('truncated TIFF IFD0');
  let orientation = null;
  for (let index = 0; index < count; index++) {
    const entry = offset + 2 + index * 12;
    if (short(entry) !== 0x112) continue;
    if (orientation !== null) invalid('duplicate IFD0 orientation');
    if (short(entry + 2) !== 3 || long(entry + 4) !== 1) invalid('orientation must be one TIFF SHORT');
    orientation = short(entry + 8);
    if (orientation < 1 || orientation > 8) invalid('orientation is outside 1-8');
  }
  return orientation ?? 1;
}

function orientationOf(buffer) {
  // Non-PNG and unrelated malformed chunks remain the existing codec's responsibility.
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) return 1;
  let orientation = 1, seen = false;
  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (type === 'eXIf') {
      if (seen) invalid('multiple eXIf chunks');
      seen = true;
      if (end > buffer.length) invalid('truncated eXIf chunk');
      if (crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) invalid('eXIf CRC mismatch');
      orientation = tiffOrientation(buffer.subarray(offset + 8, end - 4));
    } else if (end > buffer.length) break;
    if (type === 'IEND') break;
    offset = end;
  }
  return orientation;
}

/** Decode the original PNG and apply only its standard eXIf display orientation. Never infer from app bounds. */
export function orientedPng(buffer) {
  const orientation = orientationOf(buffer), image = PNG.sync.read(buffer);
  if (orientation === 1) return image;
  const width = image.width, height = image.height, swap = orientation >= 5;
  const out = new PNG({ width: swap ? height : width, height: swap ? width : height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let dx, dy;
    switch (orientation) {
      case 2: dx = width - 1 - x; dy = y; break;
      case 3: dx = width - 1 - x; dy = height - 1 - y; break;
      case 4: dx = x; dy = height - 1 - y; break;
      case 5: dx = y; dy = x; break;
      case 6: dx = height - 1 - y; dy = x; break;
      case 7: dx = height - 1 - y; dy = width - 1 - x; break;
      case 8: dx = y; dy = width - 1 - x; break;
    }
    const source = (y * width + x) * 4, target = (dy * out.width + dx) * 4;
    out.data[target] = image.data[source];
    out.data[target + 1] = image.data[source + 1];
    out.data[target + 2] = image.data[source + 2];
    out.data[target + 3] = image.data[source + 3];
  }
  return out;
}
