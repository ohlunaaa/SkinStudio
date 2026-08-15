import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { listCosmetics, prepareCosmetics } from "../src/cosmetics.js";
import { resolveSkinSource } from "../src/minecraft.js";
import { renderSkin } from "../src/renderer.js";

const CELL_WIDTH = 300;
const CELL_HEIGHT = 190;
const IMAGE_WIDTH = 145;
const IMAGE_HEIGHT = 165;
const COLUMNS = 4;
const ROWS = 5;
const PAGE_SIZE = COLUMNS * ROWS;

const outputDirectory = resolve("examples", "cosmetics", "dragon-wings-audit");
await mkdir(outputDirectory, { recursive: true });

const { items, total } = await listCosmetics({ category: "dragon_wings", limit: 10_000 });
const { skin, profile } = await resolveSkinSource(process.argv[2] || "ignLuna");
const cells = [];
const failures = [];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function label(item) {
  const text = `${item.id} · ${item.name}`;
  return Buffer.from(`
    <svg width="${CELL_WIDTH}" height="${CELL_HEIGHT}">
      <rect width="100%" height="100%" fill="#d7d9dd"/>
      <text x="8" y="181" font-family="Arial, sans-serif" font-size="13" fill="#111827">
        ${escapeXml(text.length > 40 ? `${text.slice(0, 39)}…` : text)}
      </text>
    </svg>
  `);
}

function renderView(cosmetics, yaw, view) {
  return renderSkin(skin, {
    cosmetics,
    slim: profile.slim,
    pose: "standing",
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    yaw,
    pitch: 12,
    view,
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
}

for (const [index, item] of items.entries()) {
  try {
    const cosmetics = await prepareCosmetics([item.id], { slim: profile.slim });
    cells.push({
      item,
      front: renderView(cosmetics, 0, "front"),
      back: renderView(cosmetics, 180, "back"),
    });
  } catch (error) {
    failures.push({ id: item.id, name: item.name, error: error.message });
  }
  if ((index + 1) % 10 === 0 || index + 1 === total) {
    console.log(`audited ${index + 1}/${total}; failures=${failures.length}`);
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
      { input: cell.front, left, top },
      { input: cell.back, left: left + IMAGE_WIDTH + 2, top },
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
  total,
  rendered: cells.length,
  failed: failures.length,
  failures,
}, null, 2));
console.log(`created ${Math.ceil(cells.length / PAGE_SIZE)} contact sheets in ${outputDirectory}`);
