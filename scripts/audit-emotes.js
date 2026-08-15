import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { listEmotes, prepareEmote } from "../src/emotes.js";
import { resolveSkinSource } from "../src/minecraft.js";
import { renderSkin } from "../src/renderer.js";

const CELL_WIDTH = 200;
const CELL_HEIGHT = 210;
const IMAGE_SIZE = 180;
const COLUMNS = 6;
const ROWS = 5;
const PAGE_SIZE = COLUMNS * ROWS;

const requestedPlayer = process.argv[2] || "ignLuna";
const outputDirectory = resolve("examples", "emotes-audit");
await mkdir(outputDirectory, { recursive: true });

const { skin, profile } = await resolveSkinSource(requestedPlayer);
const emotes = await listEmotes({ limit: 10_000 });
const cells = [];
const failures = [];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function label(emote) {
  const text = `${emote.id} · ${emote.name}`;
  return Buffer.from(`
    <svg width="${CELL_WIDTH}" height="${CELL_HEIGHT}">
      <rect width="100%" height="100%" fill="#d7d9dd"/>
      <text x="6" y="${CELL_HEIGHT - 6}" font-family="Arial, sans-serif" font-size="12" fill="#111827">
        ${escapeXml(text.length > 26 ? `${text.slice(0, 25)}…` : text)}
      </text>
    </svg>
  `);
}

for (const [index, item] of emotes.entries()) {
  try {
    const prepared = await prepareEmote(item.id);
    const image = renderSkin(skin, {
      emote: prepared,
      frame: 0.5,
      slim: profile.slim,
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
      background: "e8e8e8",
      layerStyle: "voxel",
      layerDepth: 1,
      overlay: true,
      shading: true,
      shadow: false,
      dropShadow: false,
      antialias: 1,
      perspective: false,
      isometric: false,
      padding: 0.08,
    });
    cells.push({ item, image });
  } catch (error) {
    failures.push({ id: item.id, name: item.name, error: error.message });
  }
  if ((index + 1) % 20 === 0 || index + 1 === emotes.length) {
    console.log(`audited ${index + 1}/${emotes.length}; failures=${failures.length}`);
  }
}

for (let pageStart = 0; pageStart < cells.length; pageStart += PAGE_SIZE) {
  const page = cells.slice(pageStart, pageStart + PAGE_SIZE);
  const pageNumber = Math.floor(pageStart / PAGE_SIZE) + 1;
  const composites = [];
  for (const [cellIndex, cell] of page.entries()) {
    const left = (cellIndex % COLUMNS) * CELL_WIDTH;
    const top = Math.floor(cellIndex / COLUMNS) * CELL_HEIGHT;
    composites.push(
      { input: label(cell.item), left, top },
      { input: cell.image, left: left + (CELL_WIDTH - IMAGE_SIZE) / 2, top },
    );
  }
  await sharp({
    create: {
      width: CELL_WIDTH * COLUMNS,
      height: CELL_HEIGHT * ROWS,
      channels: 4,
      background: "#d7d9dd",
    },
  }).composite(composites).png().toFile(resolve(outputDirectory, `catalog-${pageNumber}.png`));
}

await writeFile(resolve(outputDirectory, "summary.json"), JSON.stringify({
  total: emotes.length,
  rendered: cells.length,
  failed: failures.length,
  failures,
  emotes: emotes.map((item) => ({
    id: item.id,
    name: item.name,
    seconds: Number((item.duration / 20).toFixed(2)),
    looping: item.looping,
    hasProps: item.hasProps,
  })),
}, null, 2));
console.log(`created ${Math.ceil(cells.length / PAGE_SIZE)} contact sheets in ${outputDirectory}`);
