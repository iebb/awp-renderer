import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Buffer) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}

/** Remove the app's render margin without decoding colors or resampling pixels.
 * Keeping the original canvas during capture matters: its origin affects color
 * dithering. A Canvas / ImageIO decode and re-encode can also alter translucent
 * pixels. This only reverses PNG scanline filters and crops the stored samples.
 */
export function cropPassPng(png: Buffer, margin: number): Buffer {
  if (!Number.isSafeInteger(margin) || margin < 0 || !png.subarray(0, 8).equals(SIGNATURE))
    throw new Error('Invalid native PNG crop.');
  const chunks: { type: string; data: Buffer }[] = [];
  let ended = false;
  for (let offset = 8; offset < png.length;) {
    if (offset + 12 > png.length) throw new Error('Truncated native PNG.');
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > png.length) throw new Error('Truncated native PNG chunk.');
    if (crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4))
      throw new Error('Invalid native PNG checksum.');
    const type = png.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: png.subarray(offset + 8, end - 4) });
    offset = end;
    if (type === 'IEND') {
      if (length !== 0 || offset !== png.length) throw new Error('Invalid PNG end.');
      ended = true;
      break;
    }
  }
  const header = chunks[0];
  if (!ended || header?.type !== 'IHDR' || header.data.length !== 13)
    throw new Error('Invalid native PNG header.');
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const depth = header.data[8];
  const color = header.data[9];
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const validDepth = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
  if (
    !channels ||
    !validDepth.includes(depth) ||
    header.data[10] !== 0 ||
    header.data[11] !== 0 ||
    header.data[12] !== 0
  )
    throw new Error('Unsupported native PNG encoding.');
  const croppedWidth = width - 2 * margin;
  const croppedHeight = height - 2 * margin;
  if (croppedWidth <= 0 || croppedHeight <= 0 || width * height > 32_000_000)
    throw new Error('Invalid native PNG dimensions.');
  const bits = depth * channels;
  const rowBytes = Math.ceil((width * bits) / 8);
  const cropRowBytes = Math.ceil((croppedWidth * bits) / 8);
  const bytesPerPixel = Math.ceil(bits / 8);
  const expected = (rowBytes + 1) * height;
  if (expected > 256 * 1024 * 1024) throw new Error('Native PNG is too large.');
  const filtered = inflateSync(
    Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)),
    { maxOutputLength: expected },
  );
  if (filtered.length !== expected) throw new Error('Invalid native PNG scanlines.');
  const cropped = Buffer.alloc((cropRowBytes + 1) * croppedHeight);
  let previous = Buffer.alloc(rowBytes);
  let current = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const input = y * (rowBytes + 1);
    const filter = filtered[input];
    if (filter > 4) throw new Error('Invalid PNG row filter.');
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const above = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = above;
      else if (filter === 3) prediction = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const a = Math.abs(p - left),
          b = Math.abs(p - above),
          c = Math.abs(p - upperLeft);
        prediction = a <= b && a <= c ? left : b <= c ? above : upperLeft;
      }
      current[x] = (filtered[input + 1 + x] + prediction) & 255;
    }
    if (y >= margin && y < height - margin) {
      const output = (y - margin) * (cropRowBytes + 1) + 1;
      if (bits >= 8) {
        const start = (margin * bits) / 8;
        current.copy(cropped, output, start, start + cropRowBytes);
      } else {
        const mask = (1 << bits) - 1;
        for (let x = 0; x < croppedWidth; x++) {
          const sourceBit = (x + margin) * bits;
          const value = (current[sourceBit >> 3] >> (8 - bits - (sourceBit & 7))) & mask;
          const targetBit = x * bits;
          cropped[output + (targetBit >> 3)] |= value << (8 - bits - (targetBit & 7));
        }
      }
    }
    [previous, current] = [current, previous];
  }
  const newHeader = Buffer.from(header.data);
  newHeader.writeUInt32BE(croppedWidth, 0);
  newHeader.writeUInt32BE(croppedHeight, 4);
  const result = [SIGNATURE];
  let writtenImage = false;
  for (const original of chunks) {
    if (original.type === 'IHDR') result.push(chunk('IHDR', newHeader));
    else if (original.type === 'IDAT') {
      if (!writtenImage) result.push(chunk('IDAT', deflateSync(cropped)));
      writtenImage = true;
    } else if (original.type !== 'eXIf' && original.type !== 'dSIG') {
      // EXIF may contain the old full-canvas dimensions. Color metadata,
      // palette entries, and transparency samples are retained unchanged.
      result.push(chunk(original.type, original.data));
    }
  }
  return Buffer.concat(result);
}
