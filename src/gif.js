import { PNG } from "pngjs";
import sharp from "sharp";

export async function encodeGif(pngFrames, { fps = 12, loop = 0 } = {}) {
  if (pngFrames.length < 2) throw new Error("An animated GIF needs at least two frames.");
  const frames = pngFrames.map((frame) => PNG.sync.read(frame));
  const { width, height } = frames[0];
  if (frames.some((frame) => frame.width !== width || frame.height !== height)) {
    throw new Error("All GIF frames must have identical dimensions.");
  }

  const delay = Math.max(10, Math.round(1000 / fps));
  const rawFrames = Buffer.concat(frames.map((frame) => frame.data));
  return sharp(rawFrames, {
    animated: true,
    raw: {
      width,
      height: height * frames.length,
      channels: 4,
      pageHeight: height,
    },
  }).gif({
    delay: Array(frames.length).fill(delay),
    loop,
    colours: 256,
    dither: 0.6,
    effort: 7,
    keepDuplicateFrames: true,
  }).toBuffer();
}
