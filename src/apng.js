import { deflateSync } from "node:zlib";
import { PNG } from "pngjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);

for (let value = 0; value < 256; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  CRC_TABLE[value] = crc >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  return Buffer.concat([uint32(data.length), name, data, uint32(crc32(Buffer.concat([name, data])))]);
}

function imageData(image) {
  const raw = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const targetOffset = y * (image.width * 4 + 1);
    raw[targetOffset] = 0;
    image.data.copy(raw, targetOffset + 1, y * image.width * 4, (y + 1) * image.width * 4);
  }
  return deflateSync(raw, { level: 9 });
}

export function encodeApng(pngFrames, { fps = 12, plays = 0 } = {}) {
  if (pngFrames.length < 2) throw new Error("An APNG needs at least two frames.");
  const frames = pngFrames.map((frame) => PNG.sync.read(frame));
  const { width, height } = frames[0];
  if (frames.some((frame) => frame.width !== width || frame.height !== height)) {
    throw new Error("All APNG frames must have identical dimensions.");
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const animationControl = Buffer.concat([uint32(frames.length), uint32(plays)]);
  const chunks = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("acTL", animationControl)];
  let sequence = 0;

  frames.forEach((frame, index) => {
    const frameControl = Buffer.alloc(26);
    frameControl.writeUInt32BE(sequence, 0);
    frameControl.writeUInt32BE(width, 4);
    frameControl.writeUInt32BE(height, 8);
    frameControl.writeUInt32BE(0, 12);
    frameControl.writeUInt32BE(0, 16);
    frameControl.writeUInt16BE(1, 20);
    frameControl.writeUInt16BE(fps, 22);
    frameControl[24] = 0;
    frameControl[25] = 0;
    chunks.push(chunk("fcTL", frameControl));
    sequence += 1;

    const compressed = imageData(frame);
    if (index === 0) {
      chunks.push(chunk("IDAT", compressed));
    } else {
      chunks.push(chunk("fdAT", Buffer.concat([uint32(sequence), compressed])));
      sequence += 1;
    }
  });

  chunks.push(chunk("IEND"));
  return Buffer.concat(chunks);
}
