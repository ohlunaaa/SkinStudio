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
const requestedPlayer = process.argv[2] || "ignLuna";
const category = process.argv[3];

if (!category) {
  throw new Error("Usage: node scripts/audit-cosmetics.js [player] <category>");
}

const outputDirectory = resolve("examples", "cosmetics", "category-audit", category);
await mkdir(outputDirectory, { recursive: true });

const { items, total } = await listCosmetics({ category, limit: 10_000 });
if (!total) throw new Error(`Unknown or empty cosmetic category '${category}'.`);
const { skin, profile } = await resolveSkinSource(requestedPlayer);
const cells = [];
const failures = [];
const warnings = [];
const families = new Map();

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

function geometryStats(cosmetic) {
  const triangles = cosmetic.meshes.flatMap((mesh) => mesh.triangles || []);
  const points = triangles.flatMap((triangle) => triangle.points || []);
  const finite = points.every((point) => point.every(Number.isFinite));
  const bounds = [0, 1, 2].map((axis) => {
    const values = points.map((point) => point[axis]);
    return values.length ? [Math.min(...values), Math.max(...values)] : [0, 0];
  });
  const extents = bounds.map(([minimum, maximum]) => maximum - minimum);
  const opaquePixels = cosmetic.texture.data.reduce((count, value, index) => (
    index % 4 === 3 && value > 0 ? count + 1 : count
  ), 0);
  const signature = cosmetic.meshes.map((mesh) => {
    const meshPoints = (mesh.triangles || []).flatMap((triangle) => triangle.points || []);
    const meshExtents = [0, 1, 2].map((axis) => {
      const values = meshPoints.map((point) => point[axis]);
      return values.length ? Math.max(...values) - Math.min(...values) : 0;
    });
    return `${mesh.attachment}:${mesh.triangles?.length || 0}:${meshExtents.map((value) => value.toFixed(2)).join("x")}`;
  }).sort().join("|");
  return {
    triangles: triangles.length,
    finite,
    bounds: bounds.map((range) => range.map((value) => Number(value.toFixed(3)))),
    extents: extents.map((value) => Number(value.toFixed(3))),
    opaquePixels,
    signature,
  };
}

for (const [index, item] of items.entries()) {
  try {
    const cosmetics = await prepareCosmetics([item.id], { slim: profile.slim });
    const stats = geometryStats(cosmetics[0]);
    const family = families.get(stats.signature) || { count: 0, ids: [], names: [] };
    family.count += 1;
    if (family.ids.length < 8) {
      family.ids.push(item.id);
      family.names.push(item.name);
    }
    families.set(stats.signature, family);
    const warning = (issue) => ({ id: item.id, name: item.name, category: item.category, issue, stats });
    if (!stats.triangles) warnings.push(warning("empty_geometry"));
    if (!stats.finite) warnings.push(warning("non_finite_geometry"));
    if (!stats.opaquePixels) warnings.push(warning("transparent_texture"));
    const dimensions = [...stats.extents].sort((left, right) => right - left);
    if (stats.triangles && dimensions[1] < 0.001) {
      warnings.push(warning("collapsed_geometry"));
    }
    cells.push({
      item,
      front: renderView(cosmetics, 0, "front"),
      back: renderView(cosmetics, 180, "back"),
    });
  } catch (error) {
    failures.push({ id: item.id, name: item.name, error: error.message });
  }
  if ((index + 1) % 10 === 0 || index + 1 === total) {
    console.log(`${category}: audited ${index + 1}/${total}; failures=${failures.length}; warnings=${warnings.length}`);
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

const familyList = [...families.entries()].map(([signature, family]) => ({ signature, ...family }))
  .sort((left, right) => right.count - left.count);
await writeFile(resolve(outputDirectory, "summary.json"), JSON.stringify({
  category,
  total,
  rendered: cells.length,
  failed: failures.length,
  warningCount: warnings.length,
  familyCount: familyList.length,
  failures,
  warnings,
  families: familyList,
}, null, 2));
console.log(`${category}: created ${Math.ceil(cells.length / PAGE_SIZE)} sheets; families=${familyList.length}`);
