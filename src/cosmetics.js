import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import sharp from "sharp";

const EPSILON = 1e-5;
// A representative moment (in seconds) to sample continuous, life_time-driven
// geckolib animations at for static renders. See parseBedrockGeometry.
export const DEFAULT_ANIMATION_TIME = 1.2;
// Some aura rigs (Money Aura, Autumn Leaf Aura) bundle several particle
// instances that all share one static pivot and only tumble in place - the
// exported geometry/animation never encodes where each instance actually
// drifts to, which in the real client is handled by a particle system we
// don't have access to. For these "co-located swarm" rigs (see
// parseBedrockGeometry) we synthesize a falling, ring-scattered placement per
// instance so the aura visibly rains/falls instead of spinning motionless at
// a single point above the head.
const SWARM_FALL_CYCLE_SECONDS = 10;
const SWARM_FALL_TOP_Y = 40;
const SWARM_FALL_BOTTOM_Y = -6;
const SWARM_RING_RADIUS_MIN = 6;
const SWARM_RING_RADIUS_SPAN = 6;
const SWARM_GOLDEN_ANGLE = 2.399963229728653; // ~137.5 degrees, in radians

function pseudoRandomUnit(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}
const DEFAULT_LUNAR_ROOT = join(homedir(), ".lunarclient");
const LUNAR_TEXTURE_ENDPOINT = "https://textures.lunarclientcdn.com/file";
const FACE_INDICES = {
  front: [3, 0, 1, 2],
  back: [6, 5, 4, 7],
  right: [7, 4, 0, 3],
  left: [2, 1, 5, 6],
  top: [7, 3, 2, 6],
  bottom: [0, 4, 5, 1],
};

let catalogCache;
const textureCache = new Map();
const jsonCache = new Map();
const textCache = new Map();
const downloadCache = new Map();

export class LunarCosmeticError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function lunarRoot() {
  return resolve(process.env.LUNAR_CLIENT_DIR || DEFAULT_LUNAR_ROOT);
}

function lunarPaths() {
  const root = lunarRoot();
  return {
    root,
    manifest: join(root, "textures", "assets", "lunar", "cosmetics.json"),
    jitIndex: join(root, "textures", "assets", "lunar", "jit_index"),
    indexes: join(root, "textures", "assets", "lunar", "cosmetics", "indexes"),
    jit: join(root, "jit", "assets", "lunar-jit"),
  };
}

async function cachedJson(path) {
  let value = jsonCache.get(path);
  if (!value) {
    value = readFile(path, "utf8").then(JSON.parse);
    jsonCache.set(path, value);
  }
  return value;
}

async function cachedText(path) {
  let value = textCache.get(path);
  if (!value) {
    value = readFile(path, "utf8");
    textCache.set(path, value);
  }
  return value;
}

function resourcePath(resource) {
  if (typeof resource !== "string" || !/^lunar(?:-jit)?:/.test(resource)) return null;
  const segments = resource.replace(/^lunar(?:-jit)?:/, "").split("/").filter(Boolean);
  if (segments.includes("..")) return null;
  const path = resolve(lunarPaths().jit, ...segments);
  const withinJit = relative(lunarPaths().jit, path);
  if (withinJit.startsWith("..") || isAbsolute(withinJit)) return null;
  return path;
}

function resourceIndexKey(resource) {
  if (typeof resource !== "string" || !/^lunar(?:-jit)?:/.test(resource)) return null;
  const resourceRelative = resource.replace(/^lunar(?:-jit)?:/, "").replace(/^\/+/, "");
  if (resourceRelative.split("/").includes("..")) return null;
  return `assets/lunar/${resourceRelative}`;
}

function downloadsEnabled() {
  return !["0", "false", "no"].includes(
    String(process.env.LUNAR_COSMETIC_DOWNLOADS ?? "true").toLowerCase(),
  );
}

async function ensureResource(resource, { optional = false } = {}) {
  const path = resourcePath(resource);
  if (path && existsSync(path)) return path;
  const key = resourceIndexKey(resource);
  const entry = key && catalogCache?.jitEntries.get(key);
  if (!path || !entry) {
    if (optional) return null;
    throw new LunarCosmeticError(`Lunar JIT index has no entry for '${resource}'.`, 424);
  }
  if (!downloadsEnabled()) {
    if (optional) return null;
    throw new LunarCosmeticError(
      `Lunar asset '${resource}' is not cached and automatic downloads are disabled.`,
      424,
    );
  }

  let pending = downloadCache.get(path);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(`${LUNAR_TEXTURE_ENDPOINT}/${entry.hash}`, {
        headers: { "user-agent": "skinstudio/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new LunarCosmeticError(
          `Lunar asset download failed with HTTP ${response.status} for '${resource}'.`,
          502,
        );
      }
      const data = Buffer.from(await response.arrayBuffer());
      const hash = createHash("sha1").update(data).digest("hex");
      if (hash !== entry.hash || data.length !== entry.size) {
        throw new LunarCosmeticError(`Lunar asset integrity check failed for '${resource}'.`, 502);
      }
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${entry.hash}.tmp`;
      await writeFile(temporary, data);
      try {
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        if (!existsSync(path)) throw error;
      }
      return path;
    })();
    downloadCache.set(path, pending);
    pending.catch(() => downloadCache.delete(path));
  }
  await pending;
  return path;
}

function publicItem(item) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    animated: Boolean(item.animated),
    geckolib: Boolean(item.geckolibCosmetic),
    resource: item.resource,
    available: cosmeticAvailable(item),
  };
}

function cosmeticAvailable(item) {
  const path = resourcePath(item.resource);
  if (!path || !existsSync(path)) return false;
  if (item.geckolibCosmetic) return true;
  if (item.category === "cloak" || item.category === "dragon_wings") return true;
  return Boolean(findLegacyModel(item)?.modelPath && existsSync(findLegacyModel(item).modelPath));
}

async function loadCatalogState() {
  const paths = lunarPaths();
  if (catalogCache?.root === paths.root) return catalogCache;
  if (!existsSync(paths.manifest)) {
    throw new LunarCosmeticError(
      `Lunar Client cosmetic catalog was not found at ${paths.manifest}. `
        + "Install/start Lunar Client or set LUNAR_CLIENT_DIR.",
      503,
    );
  }

  const [items, hats, bodywear] = await Promise.all([
    cachedJson(paths.manifest),
    cachedJson(join(paths.indexes, "hats.json")).catch(() => ({})),
    cachedJson(join(paths.indexes, "bodywear.json")).catch(() => ({})),
  ]);
  const jitIndex = existsSync(paths.jitIndex) ? await cachedText(paths.jitIndex) : "";
  const jitEntries = new Map();
  for (const line of jitIndex.split(/\r?\n/)) {
    const match = /^(.*?) ([a-f0-9]{40}) (\d+) (\d+)$/.exec(line);
    if (!match) continue;
    jitEntries.set(match[1], {
      hash: match[2],
      size: Number(match[3]),
      modified: Number(match[4]),
    });
  }
  catalogCache = {
    root: paths.root,
    items,
    byId: new Map(items.map((item) => [Number(item.id), item])),
    indexes: { hats, bodywear },
    jitEntries,
  };
  return catalogCache;
}

export async function listCosmetics({ category, query, available, offset = 0, limit = 100 } = {}) {
  const state = await loadCatalogState();
  const needle = query?.trim().toLowerCase();
  let items = state.items.filter((item) => {
    if (category && item.category !== category) return false;
    if (needle && !`${item.id} ${item.name} ${item.category}`.toLowerCase().includes(needle)) return false;
    if (available != null && cosmeticAvailable(item) !== available) return false;
    return true;
  });
  const total = items.length;
  items = items.slice(offset, offset + limit).map(publicItem);
  return { total, offset, limit, items };
}

export async function getCosmetic(id) {
  const state = await loadCatalogState();
  const item = state.byId.get(Number(id));
  if (!item) throw new LunarCosmeticError(`Unknown Lunar cosmetic id '${id}'.`, 404);
  return publicItem(item);
}

function findLegacyModel(item) {
  if (!catalogCache || !item.indexType || item.indexType === "NONE") return null;
  let config = catalogCache.indexes.hats[item.indexType];
  let folder = "hats";
  if (!config) {
    config = catalogCache.indexes.bodywear[item.indexType];
    folder = "bodywear";
  }
  if (!config) return null;
  const name = config.name || item.indexType;
  return {
    config,
    folder,
    modelPath: join(lunarPaths().jit, "cosmetics", "models", folder, name, `${name}.obj`),
    modelResource: `lunar:cosmetics/models/${folder}/${name}/${name}.obj`,
  };
}

async function decodeTexture(path) {
  let value = textureCache.get(path);
  if (!value) {
    value = (async () => {
      let image = sharp(path, { animated: false });
      const metadata = await image.metadata();
      let frameWidth = metadata.width;
      let frameHeight = metadata.height;
      let animationMetadata;
      const metaPath = `${path}.mcmeta`;
      if (existsSync(metaPath)) {
        try {
          const metadataJson = await cachedJson(metaPath);
          animationMetadata = metadataJson.animation;
          const declaredWidth = Number(metadataJson.animation?.width) || frameWidth;
          const declaredHeight = Number(metadataJson.animation?.height) || declaredWidth;
          // A handful of old Lunar cloak atlases are one pixel narrower than
          // their mcmeta declaration (for example 703px instead of 704px).
          // Clamp the declared frame to the decoded bitmap so Sharp never gets
          // an out-of-bounds extraction while preserving every animation row.
          frameWidth = Math.max(1, Math.min(metadata.width, Math.floor(declaredWidth)));
          frameHeight = Math.max(1, Math.min(metadata.height, Math.floor(declaredHeight)));
        } catch {
          // A broken optional animation descriptor should not hide a valid texture.
        }
      }
      if (frameWidth < metadata.width || frameHeight < metadata.height) {
        const columns = Math.max(1, Math.floor(metadata.width / frameWidth));
        const rows = Math.max(1, Math.floor(metadata.height / frameHeight));
        const frameCount = columns * rows;
        const configuredFrames = animationMetadata?.frames;
        const middle = Math.floor((configuredFrames?.length || frameCount) / 2);
        const configured = configuredFrames?.[middle];
        const frame = Math.max(0, Math.min(
          frameCount - 1,
          Number(typeof configured === "object" ? configured.index : configured) || middle,
        ));
        image = image.extract({
          left: (frame % columns) * frameWidth,
          top: Math.floor(frame / columns) * frameHeight,
          width: frameWidth,
          height: frameHeight,
        });
      }
      const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, data };
    })();
    textureCache.set(path, value);
  }
  return value;
}

function appendQuad(target, points, uvs, attachment, metadata = {}) {
  const properties = {
    attachment,
    faceCoords: [[0, 0], [0, 1], [1, 1], [1, 0]],
  };
  target.push({
    points: [points[0], points[1], points[2]],
    uvs: [uvs[0], uvs[1], uvs[2]],
    faceCoords: [properties.faceCoords[0], properties.faceCoords[1], properties.faceCoords[2]],
    attachment,
    ...metadata,
  });
  target.push({
    points: [points[0], points[2], points[3]],
    uvs: [uvs[0], uvs[2], uvs[3]],
    faceCoords: [properties.faceCoords[0], properties.faceCoords[2], properties.faceCoords[3]],
    attachment,
    ...metadata,
  });
}

function uvCorners(u, v, width, height, scaleX = 1, scaleY = scaleX) {
  const endU = (u + width) * scaleX - Math.sign(width || 1) * EPSILON;
  const endV = (v + height) * scaleY - Math.sign(height || 1) * EPSILON;
  return [
    [u * scaleX, v * scaleY],
    [u * scaleX, endV],
    [endU, endV],
    [endU, v * scaleY],
  ];
}

function cuboidVertices(origin, size) {
  const [x0, y0, z0] = origin;
  const [width, height, depth] = size;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const z1 = z0 + depth;
  return [
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
  ];
}

function makeTexturedCuboid(
  origin,
  size,
  faces,
  attachment = "body",
  transform = (point) => point,
  metadata = {},
) {
  // Bedrock frequently uses zero-thickness cubes for layered wing feathers,
  // chains and cloth. Give those planes a microscopic physical thickness so
  // the correct side wins the depth test from both front and back views.
  const renderOrigin = origin.map((value, index) => (
    Math.abs(size[index]) < EPSILON ? value - EPSILON * 10 : value
  ));
  const renderSize = size.map((value) => (Math.abs(value) < EPSILON ? EPSILON * 20 : value));
  const vertices = cuboidVertices(renderOrigin, renderSize).map(transform);
  const triangles = [];
  for (const [faceName, face] of Object.entries(faces)) {
    if (!face) continue;
    const indices = FACE_INDICES[faceName];
    appendQuad(
      triangles,
      indices.map((index) => vertices[index]),
      face.uvs,
      attachment,
      { ...metadata, faceName },
    );
  }
  return triangles;
}

function makeCloak(texture) {
  const scaleX = texture.width / 22;
  const scaleY = texture.height / 17;
  const layout = {
    top: [1, 0, 10, 1],
    bottom: [11, 0, 10, 1],
    right: [0, 1, 1, 16],
    front: [12, 1, 10, 16],
    left: [11, 1, 1, 16],
    back: [1, 1, 10, 16],
  };
  const faces = Object.fromEntries(Object.entries(layout).map(([name, rect]) => [name, {
    uvs: uvCorners(...rect, scaleX, scaleY),
  }]));
  return [{
    attachment: "body",
    triangles: makeTexturedCuboid([-5, 8, -2.75], [10, 16, 0.5], faces, "body"),
  }];
}

function makeLegacyWings(texture) {
  // Legacy Lunar wing textures use a fixed 1024x1024 entity atlas. The two
  // visible wing panels live in 224px squares; the adjacent copies are their
  // reverse sides. Mapping the entire atlas onto two quads exposes unrelated
  // model parts as the characteristic black bars seen on older cosmetics.
  const scaleX = texture.width / 1024;
  const scaleY = texture.height / 1024;
  const upperUvs = uvCorners(0, 352, 224, 224, scaleX, scaleY);
  const lowerUvs = uvCorners(0, 576, 224, 224, scaleX, scaleY);
  const inner = 0.75;
  const outer = 13.5;
  const upperBottom = 16;
  const upperTop = 29;
  const lowerBottom = 4;
  const lowerTop = 17;
  const innerZ = -2.7;
  const outerZ = -4.2;
  const triangles = [];
  for (const side of [-1, 1]) {
    appendQuad(
      triangles,
      [
        [side * inner, upperTop, innerZ],
        [side * inner, upperBottom, innerZ],
        [side * outer, upperBottom, outerZ],
        [side * outer, upperTop, outerZ],
      ],
      upperUvs,
      "body",
    );
    appendQuad(
      triangles,
      [
        [side * outer, lowerBottom, outerZ],
        [side * outer, lowerTop, outerZ],
        [side * inner, lowerTop, innerZ],
        [side * inner, lowerBottom, innerZ],
      ],
      lowerUvs,
      "body",
    );
  }
  return [{ attachment: "body", triangles }];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      for (let index = 0; index < 4; index += 1) {
        out[row * 4 + col] += a[row * 4 + index] * b[index * 4 + col];
      }
    }
  }
  return out;
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translation = (x = 0, y = 0, z = 0) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const scaling = (x = 1, y = x, z = x) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];

function axisRotation(angleDegrees = 0, x = 0, y = 0, z = 0) {
  const length = Math.hypot(x, y, z) || 1;
  const [nx, ny, nz] = [x / length, y / length, z / length];
  const angle = (angleDegrees * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * nx * nx + c, t * nx * ny - s * nz, t * nx * nz + s * ny, 0,
    t * nx * ny + s * nz, t * ny * ny + c, t * ny * nz - s * nx, 0,
    t * nx * nz - s * ny, t * ny * nz + s * nx, t * nz * nz + c, 0,
    0, 0, 0, 1,
  ];
}

function transformPoint(matrix, [x, y, z]) {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
    matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
    matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
  ];
}

function legacyAttachment(bodyPart) {
  return {
    HEAD: "head",
    BODY: "body",
    RIGHT_ARM: "rightArm",
    LEFT_ARM: "leftArm",
    RIGHT_LEG: "rightLeg",
    LEFT_LEG: "leftLeg",
  }[bodyPart] || "body";
}

function attachmentPivot(attachment) {
  return {
    head: [0, 24, 0],
    body: [0, 24, 0],
    rightArm: [-5, 22, 0],
    leftArm: [5, 22, 0],
    rightLeg: [-2, 12, 0],
    leftLeg: [2, 12, 0],
  }[attachment] || [0, 24, 0];
}

function legacyTransform(config, applyBaseRotation = true) {
  let matrix = identity();
  for (const transform of config.transformations || []) {
    const plain = transform.values || {};
    const value = plain.player || (
      plain.angle != null || plain.x != null || plain.y != null || plain.z != null ? plain : null
    );
    if (!value) continue;
    if (transform.transformType === "translate") {
      matrix = multiply(matrix, translation(value.x, value.y, value.z));
    } else if (transform.transformType === "scale") {
      matrix = multiply(matrix, scaling(value.x, value.y, value.z));
    } else if (transform.transformType === "rotate") {
      matrix = multiply(matrix, axisRotation(value.angle, value.x, value.y, value.z));
    }
  }
  // Lunar's OBJ loader converts Blender's forward axis before applying the
  // transformations from hats.json/bodywear.json. Without this base rotation,
  // masks are viewed edge-on and bandannas wrap around the wrong head axis.
  return applyBaseRotation ? multiply(matrix, axisRotation(-90, 0, 1, 0)) : matrix;
}

function parseObj(source, texture, config, family = "hats") {
  const vertices = [];
  const texcoords = [];
  const faces = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("v ")) {
      vertices.push(line.slice(2).trim().split(/\s+/).map(Number));
    } else if (line.startsWith("vt ")) {
      texcoords.push(line.slice(3).trim().split(/\s+/).map(Number));
    } else if (line.startsWith("f ")) {
      const corners = line.slice(2).trim().split(/\s+/).map((token) => {
        const [vertex, uv] = token.split("/").map(Number);
        return {
          vertex: vertex < 0 ? vertices.length + vertex : vertex - 1,
          uv: uv < 0 ? texcoords.length + uv : uv - 1,
        };
      });
      for (let index = 1; index < corners.length - 1; index += 1) {
        faces.push([corners[0], corners[index], corners[index + 1]]);
      }
    }
  }

  const attachment = legacyAttachment(config.bodyPart);
  const pivot = attachmentPivot(attachment);
  const modelMatrix = legacyTransform(config, family === "hats");
  const convert = (point) => {
    const [x, y, z] = transformPoint(modelMatrix, point);
    const converted = [pivot[0] + x * 16, pivot[1] - y * 16, pivot[2] - z * 16];
    // These older Lunar OBJs store their visible front on the opposite side.
    // Flip them around the center of the player's head. `facebandanna` is a
    // separate mouth-covering model and intentionally keeps its own axis.
    if (["bandanna", "panda"].includes(config.name)) {
      return [-converted[0], converted[1], -converted[2]];
    }
    return converted;
  };
  return [{
    attachment,
    triangles: faces.map((face) => ({
      attachment,
      points: face.map((corner) => convert(vertices[corner.vertex])),
      uvs: face.map((corner) => {
        const uv = texcoords[corner.uv] || [0, 0];
        return [
          Math.max(0, Math.min(texture.width - EPSILON, uv[0] * texture.width)),
          Math.max(0, Math.min(texture.height - EPSILON, (1 - uv[1]) * texture.height)),
        ];
      }),
      faceCoords: [[0, 0], [0, 1], [1, 1]],
    })),
  }];
}

function bedrockRotation(rotation = [0, 0, 0]) {
  let matrix = identity();
  matrix = multiply(matrix, axisRotation(rotation[2], 0, 0, 1));
  matrix = multiply(matrix, axisRotation(rotation[1], 0, 1, 0));
  matrix = multiply(matrix, axisRotation(rotation[0], 1, 0, 0));
  return matrix;
}

function aroundPivot(pivot = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1], offset = [0, 0, 0]) {
  return multiply(
    multiply(
      multiply(translation(offset[0], offset[1], offset[2]), translation(...pivot)),
      multiply(bedrockRotation(rotation), scaling(scale[0], scale[1], scale[2])),
    ),
    translation(-(pivot[0] || 0), -(pivot[1] || 0), -(pivot[2] || 0)),
  );
}

function tokenizeExpression(source) {
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    const match = /^\s*(?:(\d+(?:\.\d*)?|\.\d+)|([A-Za-z_][A-Za-z0-9_.]*)|(==|!=|<=|>=|\|\||&&)|(.))/s.exec(source.slice(offset));
    if (!match) break;
    offset += match[0].length;
    if (match[1]) tokens.push({ type: "number", value: Number(match[1]) });
    else if (match[2]) tokens.push({ type: "name", value: match[2].toLowerCase() });
    else if (match[3]) tokens.push({ type: match[3], value: match[3] });
    else if ("+-*/%(),!<>?:".includes(match[4])) tokens.push({ type: match[4], value: match[4] });
    else return [];
  }
  return tokens;
}

function evaluateMolang(value, scope = {}) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) scope = {};
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const statements = value.split(";").map((statement) => statement.trim()).filter(Boolean);
  if (statements.length > 1) {
    let result = 0;
    for (const statement of statements) {
      const normalized = statement.replace(/^return\s+/i, "");
      const assignment = /^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.+)$/s.exec(normalized);
      if (assignment) {
        result = evaluateMolang(assignment[2], scope);
        scope[assignment[1].toLowerCase()] = result;
      } else {
        result = evaluateMolang(normalized, scope);
      }
    }
    return result;
  }
  const expression = (statements[0] || value)
    .replace(/^return\s+/i, "")
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_.]*)\s*\?\?\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/g,
      (match, name, fallback) => {
        const key = name.toLowerCase();
        return Object.hasOwn(scope, key) ? String(scope[key]) : fallback;
      },
    );
  const assignment = /^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.+)$/s.exec(expression);
  if (assignment) {
    const result = evaluateMolang(assignment[2], scope);
    scope[assignment[1].toLowerCase()] = result;
    return result;
  }
  const tokens = tokenizeExpression(expression);
  if (!tokens.length) return 0;
  let cursor = 0;
  const peek = (type) => tokens[cursor]?.type === type;
  const take = (type) => (peek(type) ? tokens[cursor++] : null);
  const functions = {
    "math.abs": Math.abs,
    "math.ceil": Math.ceil,
    "math.clamp": (number, minimum, maximum) => Math.max(minimum, Math.min(maximum, number)),
    "math.cos": (degrees) => Math.cos((degrees * Math.PI) / 180),
    "math.floor": Math.floor,
    "math.lerp": (start, end, amount) => start + (end - start) * amount,
    "math.max": Math.max,
    "math.min": Math.min,
    "math.mod": (left, right) => ((left % right) + right) % right,
    "math.pow": Math.pow,
    "math.sin": (degrees) => Math.sin((degrees * Math.PI) / 180),
    "math.sqrt": Math.sqrt,
    "lunar.movewave_sin": (speed, amplitude, offset = 0) => (
      Math.sin(((scope["q.life_time"] || 0) * speed + offset) * Math.PI / 180) * amplitude
    ),
  };
  const variables = {
    "math.pi": Math.PI,
    "q.life_time": 0,
    "query.life_time": 0,
    ...scope,
  };

  const primary = () => {
    if (take("(")) {
      const result = conditional();
      take(")");
      return result;
    }
    const number = take("number");
    if (number) return number.value;
    const name = take("name");
    if (!name) return 0;
    if (take("(")) {
      const args = [];
      if (!peek(")")) {
        do args.push(conditional()); while (take(","));
      }
      take(")");
      return functions[name.value]?.(...args) ?? 0;
    }
    return variables[name.value] ?? 0;
  };
  const unary = () => {
    if (take("+")) return unary();
    if (take("-")) return -unary();
    if (take("!")) return unary() ? 0 : 1;
    return primary();
  };
  const multiplication = () => {
    let result = unary();
    while (peek("*") || peek("/") || peek("%")) {
      const operator = tokens[cursor++].type;
      const right = unary();
      if (operator === "*") result *= right;
      else if (operator === "/") result /= right;
      else result %= right;
    }
    return result;
  };
  function addition() {
    let result = multiplication();
    while (peek("+") || peek("-")) {
      const operator = tokens[cursor++].type;
      const right = multiplication();
      result = operator === "+" ? result + right : result - right;
    }
    return result;
  }
  const comparison = () => {
    let result = addition();
    while (peek("<") || peek(">") || peek("<=") || peek(">=")) {
      const operator = tokens[cursor++].type;
      const right = addition();
      if (operator === "<") result = Number(result < right);
      else if (operator === ">") result = Number(result > right);
      else if (operator === "<=") result = Number(result <= right);
      else result = Number(result >= right);
    }
    return result;
  };
  const equality = () => {
    let result = comparison();
    while (peek("==") || peek("!=")) {
      const operator = tokens[cursor++].type;
      const right = comparison();
      result = Number(operator === "==" ? result === right : result !== right);
    }
    return result;
  };
  const logicalAnd = () => {
    let result = equality();
    while (take("&&")) {
      const right = equality();
      result = Number(Boolean(result) && Boolean(right));
    }
    return result;
  };
  const logicalOr = () => {
    let result = logicalAnd();
    while (take("||")) {
      const right = logicalAnd();
      result = Number(Boolean(result) || Boolean(right));
    }
    return result;
  };
  function conditional() {
    const condition = logicalOr();
    if (!take("?")) return condition;
    const truthy = conditional();
    take(":");
    const falsy = conditional();
    return condition ? truthy : falsy;
  }
  const result = conditional();
  return Number.isFinite(result) ? result : 0;
}

function keyframeVector(frame, fallback, scope) {
  if (Array.isArray(frame)) return vectorValue(frame, fallback, scope);
  return vectorValue(frame?.post || frame?.pre || frame?.vector, fallback, scope);
}

function vectorValue(value, fallback, scope = {}) {
  if (Array.isArray(value)) return value.map((entry) => evaluateMolang(entry, scope));
  if (typeof value === "number" || typeof value === "string") {
    const scalar = evaluateMolang(value, scope);
    return [scalar, scalar, scalar];
  }
  if (value?.vector) return vectorValue(value.vector, fallback, scope);
  if (!value || typeof value !== "object") return fallback;
  const keyframes = Object.entries(value)
    .filter(([key]) => Number.isFinite(Number(key)))
    .map(([key, frame]) => [Number(key), frame])
    .sort(([left], [right]) => left - right);
  if (!keyframes.length) return fallback;
  // These tracks are real Bedrock keyframe timelines (time -> vector), not a
  // single formula. The animated moment lives in scope["q.life_time"]; without
  // sampling by that time every bone froze at whichever keyframe happened to
  // sort first (often a scale-to-zero "pop in" frame), collapsing cosmetics
  // like Ghost Aura to an invisible point instead of an animated body.
  const lifeTime = Number(scope["q.life_time"]) || 0;
  if (lifeTime <= keyframes[0][0]) return keyframeVector(keyframes[0][1], fallback, scope);
  const last = keyframes[keyframes.length - 1];
  if (lifeTime >= last[0]) return keyframeVector(last[1], fallback, scope);
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const [startTime, startFrame] = keyframes[index];
    const [endTime, endFrame] = keyframes[index + 1];
    if (lifeTime < startTime || lifeTime > endTime) continue;
    const start = keyframeVector(startFrame, fallback, scope);
    const end = keyframeVector(endFrame, fallback, scope);
    const amount = endTime > startTime ? (lifeTime - startTime) / (endTime - startTime) : 0;
    return start.map((component, axis) => component + (end[axis] - component) * amount);
  }
  return fallback;
}

function selectStaticAnimation(descriptor, animationJson) {
  const animations = animationJson?.animations;
  if (!animations) return null;
  let requested = descriptor.state_machine?.anim;
  if (!requested && typeof descriptor.default_anim === "string") requested = descriptor.default_anim;
  if (!requested && descriptor.default_anim && typeof descriptor.default_anim === "object") {
    requested = Object.entries(descriptor.default_anim)
      .find(([, condition]) => String(condition).trim() === "1")?.[0];
  }
  for (const controller of descriptor.state_machine?.controllers || []) {
    const states = controller.states || [];
    requested = states.find((state) => String(state.plays_when).trim() === "1")?.anim
      || states.find((state) => String(state.anim).toLowerCase().includes("idle"))?.anim
      || states.find((state) => !String(state.anim).toLowerCase().includes("gui"))?.anim
      || requested;
  }
  if (requested && animations[requested]) return animations[requested];
  if (requested) {
    const matched = Object.entries(animations).find(([name]) => name.endsWith(`.${requested}`));
    if (matched) return matched[1];
  }
  return Object.values(animations)[0] || null;
}

function animationTransform(
  animation,
  bone,
  scope,
  neutralAnimatedRotation = false,
  neutralBaseRotation = false,
) {
  const animated = animation?.bones?.[bone.name] || {};
  const baseRotation = neutralBaseRotation ? [0, 0, 0] : (bone.rotation || [0, 0, 0]);
  const extraRotation = neutralAnimatedRotation
    ? [0, 0, 0]
    : vectorValue(animated.rotation, [0, 0, 0], scope);
  return {
    rotation: baseRotation.map((value, index) => value + (extraRotation[index] || 0)),
    position: vectorValue(animated.position, [0, 0, 0], scope),
    scale: vectorValue(animated.scale, bone.scale || [1, 1, 1], scope),
  };
}

function attachmentFromNames(names, descriptor) {
  if (descriptor.type === "companion") return "world";
  const normalized = [...names].reverse().map((rawName) => rawName.toLowerCase().replaceAll("_", ""));
  const playerBones = normalized.filter((name) => name.includes("biped") || name.includes("armor"));
  const separatelyRigged = ["suits", "hat", "backpack", "shoes", "wristwear"].includes(descriptor.type);
  const candidates = playerBones.length || !separatelyRigged ? playerBones : normalized;
  for (const name of candidates) {
    if (name.includes("rightarm") || name.includes("armright")) return "rightArm";
    if (name.includes("leftarm") || name.includes("armleft")) return "leftArm";
    if (name.includes("rightleg") || name.includes("legright")) return "rightLeg";
    if (name.includes("leftleg") || name.includes("legleft")) return "leftLeg";
    if (name.includes("head")) return "head";
    if (name.includes("body") || name.includes("chest") || name.includes("torso")) return "body";
  }
  return legacyAttachment(descriptor.attached_bone) || "body";
}

function bedrockFaceMap(cube, scaleX, scaleY, swapNorthSouth = false) {
  if (!cube.uv) return {};
  let mapping;
  if (Array.isArray(cube.uv)) {
    const [u, v] = cube.uv;
    const [width, height, depth] = cube.size.map(Math.abs);
    mapping = {
      front: { uv: [u + depth * 2 + width, v + depth], uv_size: [width, height] },
      back: { uv: [u + depth, v + depth], uv_size: [width, height] },
      right: { uv: [u, v + depth], uv_size: [depth, height] },
      left: { uv: [u + depth + width, v + depth], uv_size: [depth, height] },
      top: { uv: [u + depth, v], uv_size: [width, depth] },
      bottom: { uv: [u + depth + width, v], uv_size: [width, depth] },
    };
  } else {
    mapping = {
      front: swapNorthSouth ? cube.uv.north : cube.uv.south,
      back: swapNorthSouth ? cube.uv.south : cube.uv.north,
      right: cube.uv.west,
      left: cube.uv.east,
      top: cube.uv.up,
      bottom: cube.uv.down,
    };
  }
  return Object.fromEntries(Object.entries(mapping).flatMap(([name, face]) => {
    if (!face?.uv || !face.uv_size || face.uv_size[0] === 0 || face.uv_size[1] === 0) return [];
    return [[name, { uvs: uvCorners(face.uv[0], face.uv[1], face.uv_size[0], face.uv_size[1], scaleX, scaleY) }]];
  }));
}

function parseBedrockGeometry(geometryJson, texture, descriptor, animationJson) {
  const geometry = geometryJson["minecraft:geometry"]?.[0];
  if (!geometry) throw new LunarCosmeticError("The Lunar Gecko model has no minecraft:geometry entry.", 422);
  const logicalWidth = geometry.description?.texture_width || texture.width;
  const logicalHeight = geometry.description?.texture_height || texture.height;
  const scaleX = texture.width / logicalWidth;
  const scaleY = texture.height / logicalHeight;
  const bones = geometry.bones || [];
  const byName = new Map(bones.map((bone) => [bone.name, bone]));
  const cubes = bones.flatMap((bone) => bone.cubes || []);
  const planarWingEntries = bones.flatMap((bone) => (bone.cubes || [])
    .filter((cube) => (
      Math.abs(cube.size?.[2] || 0) < EPSILON
      && cube.uv
      && !Array.isArray(cube.uv)
    ))
    .map((cube) => ({ bone, cube })));
  const shoulderPet = descriptor.type === "pet" && descriptor.attached_bone === "SHOULDER";
  const dragonWingModel = descriptor.cosmeticCategory === "dragon_wings";
  // Auras reuse the same shoulder-pet attachment plumbing as backpack wings,
  // but their fully-planar cubes are individually spinning particles/ribbons,
  // not an assembled wing panel that needs to stay flat. Applying the wing
  // flattening heuristic to them froze every particle's own spin at identity,
  // which is what turned Wind Aura/Rainbow Aura into stacked horizontal slats.
  const auraModel = descriptor.cosmeticCategory === "auras";
  const neutralPlanarWingRotation = !auraModel
    && shoulderPet
    && planarWingEntries.length > 1
    && (dragonWingModel || planarWingEntries.length === cubes.length);
  // A "co-located swarm": several top-level instance bones (one per leaf,
  // bill, ...) that all share the exact same static pivot, meaning the rig
  // never spreads them apart or moves them on its own. See SWARM_* above.
  let swarmInstances = null;
  if (auraModel && shoulderPet) {
    for (const root of bones.filter((bone) => !bone.parent)) {
      const children = bones.filter((bone) => bone.parent === root.name);
      if (children.length < 3) continue;
      const [firstChild] = children;
      const firstPivot = firstChild.pivot || [0, 0, 0];
      const identicalPivots = children.every((child) => {
        const pivot = child.pivot || [0, 0, 0];
        return Math.hypot(
          pivot[0] - firstPivot[0],
          pivot[1] - firstPivot[1],
          pivot[2] - firstPivot[2],
        ) < EPSILON;
      });
      if (identicalPivots) {
        swarmInstances = children;
        break;
      }
    }
  }
  const swarmIndexByName = new Map((swarmInstances || []).map((bone, index) => [bone.name, index]));
  const planarLineage = new Set();
  for (const { bone } of planarWingEntries) {
    let current = bone;
    while (current) {
      planarLineage.add(current.name);
      current = current.parent && byName.get(current.parent);
    }
  }
  const edgeOnPlanarCarriers = new Set(bones.filter((bone) => {
    const [x = 0, y = 0, z = 0] = bone.rotation || [];
    return neutralPlanarWingRotation
      && planarLineage.has(bone.name)
      && !(bone.cubes?.length)
      && Math.abs(Math.abs(x) - 90) <= 1
      && Math.abs(y) < EPSILON
      && Math.abs(z) < EPSILON;
  }).map((bone) => bone.name));
  const matrixCache = new Map();
  const lineageCache = new Map();
  const animation = selectStaticAnimation(descriptor, animationJson);
  // Geckolib cosmetics (pets, companions, auras) drive their bone poses off
  // q.life_time rather than fixed keyframes. Sampling at life_time 0 lands on
  // the rig's rest/spawn instant, which for many of these rigs (Ghost Aura,
  // Wind Aura, ...) is a scaled-to-zero or not-yet-spread starting pose.
  // Callers rendering an animated sequence pass a real, advancing life_time
  // (see server.js) so auras visibly swirl/fall across frames instead of
  // freezing; a single-frame render falls back to one representative moment.
  // server.js ping-pongs this value across an animated sequence so it ends
  // back near where it started - this bone animation has no natural loop
  // point of its own, so without that the GIF would visibly snap when it
  // repeats. fallTime is a separate, monotonic clock for the co-located
  // swarm fall below, which wants a one-way drift instead of a reversal.
  const requestedLifeTime = Number.isFinite(descriptor.lifeTime) ? descriptor.lifeTime : DEFAULT_ANIMATION_TIME;
  const fallTime = Number.isFinite(descriptor.fallTime) ? descriptor.fallTime : requestedLifeTime;
  const animationLength = Number(animation?.animation_length);
  const lifeTime = (animation?.loop !== false && animationLength > 0)
    ? (((requestedLifeTime % animationLength) + animationLength) % animationLength)
    : requestedLifeTime;
  const animationScope = {
    "t.none": 1,
    "t.desert": 0,
    "t.ocean": 0,
    "t.nether": 0,
    "t.end": 0,
    "q.life_time": lifeTime,
    "query.life_time": lifeTime,
  };
  for (const option of descriptor.cosmetic_options || []) {
    if (!option?.molang_query || option.default == null) continue;
    const value = Number(option.default);
    if (Number.isFinite(value)) {
      animationScope[String(option.molang_query).toLowerCase()] = value;
    }
  }

  const boneMatrix = (bone) => {
    if (matrixCache.has(bone.name)) return matrixCache.get(bone.name);
    const parent = bone.parent && byName.get(bone.parent);
    const animated = animationTransform(
      animation,
      bone,
      animationScope,
      neutralPlanarWingRotation,
      edgeOnPlanarCarriers.has(bone.name),
    );
    const matrix = multiply(
      parent ? boneMatrix(parent) : identity(),
      aroundPivot(bone.pivot, animated.rotation, animated.scale, animated.position),
    );
    matrixCache.set(bone.name, matrix);
    return matrix;
  };
  const lineage = (bone) => {
    if (lineageCache.has(bone.name)) return lineageCache.get(bone.name);
    const parent = bone.parent && byName.get(bone.parent);
    const value = [...(parent ? lineage(parent) : []), bone.name];
    lineageCache.set(bone.name, value);
    return value;
  };
  const swarmScatter = (bone) => {
    if (!swarmInstances) return null;
    const instanceName = lineage(bone).find((name) => swarmIndexByName.has(name));
    if (instanceName == null) return null;
    const index = swarmIndexByName.get(instanceName);
    const count = swarmInstances.length;
    const angle = index * SWARM_GOLDEN_ANGLE;
    const radius = SWARM_RING_RADIUS_MIN + pseudoRandomUnit(index + 1) * SWARM_RING_RADIUS_SPAN;
    const fallHeight = SWARM_FALL_TOP_Y - SWARM_FALL_BOTTOM_Y;
    const phase = pseudoRandomUnit(index + 10);
    const cyclePosition = (((fallTime / SWARM_FALL_CYCLE_SECONDS) + index / count + phase) % 1 + 1) % 1;
    const basePivot = byName.get(instanceName)?.pivot || [0, 0, 0];
    return [
      Math.cos(angle) * radius - basePivot[0],
      (SWARM_FALL_TOP_Y - cyclePosition * fallHeight) - basePivot[1],
      Math.sin(angle) * radius - basePivot[2],
    ];
  };

  const grouped = new Map();
  for (const [boneIndex, bone] of bones.entries()) {
    if (!bone.cubes?.length) continue;
    const attachment = attachmentFromNames(lineage(bone), descriptor);
    let target = grouped.get(attachment);
    if (!target) {
      target = [];
      grouped.set(attachment, target);
    }
    const parentMatrix = boneMatrix(bone);
    const scatter = swarmScatter(bone);
    for (const [cubeIndex, cube] of bone.cubes.entries()) {
      const inflate = Number(cube.inflate || 0);
      const origin = cube.origin.map((value) => value - inflate);
      const size = cube.size.map((value) => value + inflate * 2);
      const cubeMatrix = multiply(parentMatrix, aroundPivot(cube.pivot, cube.rotation));
      target.push(...makeTexturedCuboid(
        origin,
        size,
        bedrockFaceMap(
          cube,
          scaleX,
          scaleY,
          dragonWingModel && Math.abs(cube.size?.[2] || 0) < EPSILON,
        ),
        attachment,
        (point) => {
          const transformed = transformPoint(cubeMatrix, point);
          const scattered = scatter
            ? [transformed[0] + scatter[0], transformed[1] + scatter[1], transformed[2] + scatter[2]]
            : transformed;
          return [scattered[0], scattered[1], -scattered[2]];
        },
        { renderOrder: boneIndex * 1_000 + cubeIndex },
      ));
    }
  }
  return [...grouped.entries()].map(([attachment, triangles]) => {
    if (descriptor.type !== "companion") return { attachment, triangles };
    return {
      attachment,
      triangles: triangles.map((triangle) => ({
        ...triangle,
        points: triangle.points.map(([x, y, z]) => [x - 11, y, z]),
      })),
    };
  });
}

function missingAsset(item, paths) {
  throw new LunarCosmeticError(
    `Lunar cosmetic ${item.id} (${item.name}) is known, but its model/texture is not in the local JIT cache. `
      + "Open the cosmetic once in Lunar Client and retry.",
    424,
    { cosmetic: publicItem(item), missing: paths },
  );
}

function conditionalResource(value, slim) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value);
  const matched = entries.find(([, condition]) => {
    const normalized = String(condition).replaceAll(" ", "").toLowerCase();
    return slim ? normalized === "q.is_slim_model" : normalized === "!q.is_slim_model";
  });
  return matched?.[0] || entries[0]?.[0] || null;
}

async function prepareGecko(item, { slim = false, lifeTime, fallTime } = {}) {
  const descriptorPath = await ensureResource(item.resource);
  const descriptor = await cachedJson(descriptorPath);
  const modelResource = conditionalResource(descriptor.model, slim);
  const textureResource = conditionalResource(descriptor.texture, slim);
  const [modelPath, texturePath, animationPath] = await Promise.all([
    ensureResource(modelResource),
    ensureResource(textureResource),
    descriptor.animation ? ensureResource(descriptor.animation, { optional: true }) : null,
    ensureResource(`${textureResource}.mcmeta`, { optional: true }),
  ]);
  const [geometry, texture, animation] = await Promise.all([
    cachedJson(modelPath),
    decodeTexture(texturePath),
    animationPath ? cachedJson(animationPath) : null,
  ]);
  const hiddenParts = [
    ["hide_head", "head"],
    ["hide_body", "body"],
    ["hide_right_arm", "rightArm"],
    ["hide_left_arm", "leftArm"],
    ["hide_right_leg", "rightLeg"],
    ["hide_left_leg", "leftLeg"],
  ].filter(([flag]) => descriptor[flag] === true).map(([, part]) => part);
  return {
    ...publicItem(item),
    texture,
    hiddenParts,
    meshes: parseBedrockGeometry(
      geometry,
      texture,
      { ...descriptor, cosmeticCategory: item.category, lifeTime, fallTime },
      animation,
    ),
  };
}

async function prepareLegacy(item) {
  const texturePath = await ensureResource(item.resource);
  await ensureResource(`${item.resource}.mcmeta`, { optional: true });
  const texture = await decodeTexture(texturePath);
  if (item.category === "cloak") {
    return { ...publicItem(item), texture, meshes: makeCloak(texture) };
  }
  if (item.category === "dragon_wings") {
    return { ...publicItem(item), texture, meshes: makeLegacyWings(texture) };
  }
  const model = findLegacyModel(item);
  if (!model?.modelPath || !model.modelResource) {
    missingAsset(item, [model?.modelPath].filter(Boolean));
  }
  const modelPath = await ensureResource(model.modelResource);
  const source = await cachedText(modelPath);
  const meshes = parseObj(source, texture, model.config, model.folder);
  if (item.category === "bandanna") {
    for (const mesh of meshes) {
      for (const triangle of mesh.triangles) {
        triangle.points = triangle.points.map(([x, y, z]) => [x * 1.16, y, z * 1.16]);
      }
    }
  }
  return {
    ...publicItem(item),
    texture,
    meshes,
  };
}

export async function prepareCosmetics(ids, options = {}) {
  if (!ids?.length) return [];
  const state = await loadCatalogState();
  return Promise.all(ids.map(async (id) => {
    const item = state.byId.get(Number(id));
    if (!item) throw new LunarCosmeticError(`Unknown Lunar cosmetic id '${id}'.`, 404);
    return item.geckolibCosmetic ? prepareGecko(item, options) : prepareLegacy(item);
  }));
}
