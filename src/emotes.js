import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import sharp from "sharp";

const DEFAULT_LUNAR_ROOT = join(homedir(), ".lunarclient");
const MODEL_SCALE = 16;

let catalogCache;
const textCache = new Map();
const actionCache = new Map();
const rigCache = new Map();
const propCache = new Map();
const propTextureCache = new Map();

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
  const result = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      for (let index = 0; index < 4; index += 1) {
        result[row * 4 + column] += a[row * 4 + index] * b[index * 4 + column];
      }
    }
  }
  return result;
}

function compose(...matrices) {
  return matrices.reduce((current, matrix) => multiply(current, matrix), identity());
}

function translation(x = 0, y = 0, z = 0) {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
}

function rotationX(angle = 0) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [1, 0, 0, 0, 0, cosine, -sine, 0, 0, sine, cosine, 0, 0, 0, 0, 1];
}

function rotationY(angle = 0) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [cosine, 0, sine, 0, 0, 1, 0, 0, -sine, 0, cosine, 0, 0, 0, 0, 1];
}

function rotationZ(angle = 0) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [cosine, -sine, 0, 0, sine, cosine, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function scaling(x = 1, y = 1, z = 1) {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

function rigidInverse(matrix) {
  const result = identity();
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      result[row * 4 + column] = matrix[column * 4 + row];
    }
  }
  const offset = [matrix[3], matrix[7], matrix[11]];
  result[3] = -(result[0] * offset[0] + result[1] * offset[1] + result[2] * offset[2]);
  result[7] = -(result[4] * offset[0] + result[5] * offset[1] + result[6] * offset[2]);
  result[11] = -(result[8] * offset[0] + result[9] * offset[1] + result[10] * offset[2]);
  return result;
}

export class LunarEmoteError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function lunarEmoteRoot() {
  const lunarRoot = resolve(process.env.LUNAR_CLIENT_DIR || DEFAULT_LUNAR_ROOT);
  return resolve(
    process.env.LUNAR_EMOTES_DIR
      || join(lunarRoot, "textures", "assets", "lunar", "emotes"),
  );
}

async function cachedText(path) {
  let value = textCache.get(path);
  if (!value) {
    value = readFile(path, "utf8");
    textCache.set(path, value);
  }
  return value;
}

function publicEmote(emote) {
  return {
    id: emote.id,
    name: emote.name,
    author: emote.author,
    duration: emote.duration,
    looping: Boolean(emote.looping),
    stopOnMove: Boolean(emote.stopOnMove),
    hasProps: Boolean(emote.meshes?.length || emote.morph),
  };
}

async function loadCatalog() {
  const root = lunarEmoteRoot();
  if (catalogCache?.root === root) return catalogCache;
  const manifest = join(root, "emotes.json");
  if (!existsSync(manifest)) {
    throw new LunarEmoteError(
      `Lunar Client emote catalog was not found at ${manifest}. `
        + "Install/start Lunar Client or set LUNAR_CLIENT_DIR.",
      503,
    );
  }
  let source;
  try {
    source = JSON.parse(await readFile(manifest, "utf8"));
  } catch (error) {
    throw new LunarEmoteError(`Lunar Client emote catalog is invalid: ${error.message}`, 500);
  }
  const emotes = Array.isArray(source.emotes) ? source.emotes : [];
  const actions = Array.isArray(source.actions) ? source.actions : [];
  catalogCache = {
    root,
    emotes,
    actions,
    meshes: source.meshes && typeof source.meshes === "object" ? source.meshes : {},
    props: Array.isArray(source.props) ? source.props : [],
    byId: new Map(emotes.map((emote) => [Number(emote.id), emote])),
    byName: new Map(emotes.map((emote) => [String(emote.name).toLowerCase(), emote])),
  };
  return catalogCache;
}

export async function listEmotes({ query, looping, offset = 0, limit = 100 } = {}) {
  const catalog = await loadCatalog();
  const needle = query?.trim().toLowerCase();
  return catalog.emotes
    .filter((emote) => !needle
      || String(emote.name).toLowerCase().includes(needle)
      || String(emote.id) === needle)
    .filter((emote) => looping == null || Boolean(emote.looping) === looping)
    .slice(offset, offset + limit)
    .map(publicEmote);
}

async function catalogEmote(identifier) {
  const catalog = await loadCatalog();
  const raw = String(identifier ?? "").trim();
  const emote = /^\d+$/.test(raw)
    ? catalog.byId.get(Number(raw))
    : catalog.byName.get(raw.toLowerCase());
  if (!emote) {
    throw new LunarEmoteError(`Unknown Lunar emote '${raw}'. Try GET /v1/emotes.`, 404);
  }
  return { catalog, emote };
}

export async function getEmote(identifier) {
  const { emote } = await catalogEmote(identifier);
  return publicEmote(emote);
}

function resourcePath(root, resource) {
  if (typeof resource !== "string" || !resource.startsWith("lunar:")) return null;
  const segments = resource.slice("lunar:".length).split("/").filter(Boolean);
  if (segments.includes("..")) return null;
  // The emote root already represents assets/lunar/emotes.
  if (segments[0] === "emotes") segments.shift();
  const path = resolve(root, ...segments);
  const withinRoot = relative(root, path);
  if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) return null;
  return path;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function actionSection(text, actionName) {
  const match = new RegExp(`(?:^|\\n)an ${escapeRegex(actionName)}\\r?\\n`).exec(text);
  if (!match) return null;
  const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
  const remaining = text.slice(start);
  const next = /\n(?:an )/.exec(remaining.slice(1));
  return next ? remaining.slice(0, next.index + 1) : remaining;
}

function parseAction(section, expectedName) {
  const bones = new Map();
  let name;
  let bone;
  let property;
  let axis;
  let maximumFrame = 0;

  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields[0] === "an") {
      name = fields.slice(1).join(" ");
      continue;
    }
    if (fields[0] === "ao") {
      bone = fields.slice(1).join(" ");
      if (!bones.has(bone)) {
        bones.set(bone, {
          rotation: [[], [], []],
          location: [[], [], []],
          scale: [[], [], []],
        });
      }
      property = undefined;
      axis = undefined;
      continue;
    }
    if (fields[0] === "ag") {
      property = fields[1];
      axis = Number(fields[2]);
      continue;
    }
    if (fields[0] !== "kf" || !bone || !["rotation", "location", "scale"].includes(property)) continue;
    if (!Number.isInteger(axis) || axis < 0 || axis > 2) continue;
    const numbers = [fields[1], fields[2], fields[4], fields[5], fields[6], fields[7]].map(Number);
    if (!numbers.every(Number.isFinite)) continue;
    const [time, value, leftX, leftY, rightX, rightY] = numbers;
    bones.get(bone)[property][axis].push({
      time,
      value,
      interpolation: String(fields[3] || "LINEAR").toUpperCase(),
      left: [leftX, leftY],
      right: [rightX, rightY],
    });
    maximumFrame = Math.max(maximumFrame, time);
  }

  if (name !== expectedName) {
    throw new LunarEmoteError(`Expected Lunar action '${expectedName}', got '${name || "none"}'.`, 500);
  }
  return { name, bones, maximumFrame };
}

async function loadAction(catalog, emote) {
  const cacheKey = `${catalog.root}\0${emote.id}`;
  let value = actionCache.get(cacheKey);
  if (value) return value;
  value = (async () => {
    const actionName = `emote_${emote.name}`;
    for (const resource of catalog.actions) {
      const path = resourcePath(catalog.root, resource);
      if (!path || !existsSync(path)) continue;
      const text = await cachedText(path);
      const section = actionSection(text, actionName);
      if (section) return parseAction(section, actionName);
    }
    throw new LunarEmoteError(
      `Animation data for Lunar emote '${emote.name}' (${emote.id}) is not installed.`,
      424,
    );
  })();
  actionCache.set(cacheKey, value);
  value.catch(() => actionCache.delete(cacheKey));
  return value;
}

async function loadRig(catalog) {
  let value = rigCache.get(catalog.root);
  if (value) return value;
  value = (async () => {
    const path = join(catalog.root, "models", "entity", "default.bobj");
    if (!existsSync(path)) {
      throw new LunarEmoteError(`Lunar emote rig was not found at ${path}.`, 424);
    }
    const bones = new Map();
    for (const rawLine of (await cachedText(path)).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("arm_bone ")) continue;
      const fields = line.split(/\s+/);
      const hasParent = fields.length >= 22;
      const name = fields[1];
      const parent = hasParent ? fields[2] : "";
      const matrixOffset = hasParent ? 6 : 5;
      const bind = fields.slice(matrixOffset, matrixOffset + 16).map(Number);
      if (bind.length !== 16 || !bind.every(Number.isFinite)) continue;
      bind[3] *= MODEL_SCALE;
      bind[7] *= MODEL_SCALE;
      bind[11] *= MODEL_SCALE;
      bones.set(name, { name, parent, bind, inverseBind: rigidInverse(bind) });
    }
    for (const bone of bones.values()) {
      bone.relative = bone.parent && bones.has(bone.parent)
        ? multiply(bones.get(bone.parent).inverseBind, bone.bind)
        : bone.bind;
    }
    if (!bones.has("anchor") || !bones.has("head")) {
      throw new LunarEmoteError("Lunar emote rig has no usable armature.", 500);
    }
    return { bones };
  })();
  rigCache.set(catalog.root, value);
  value.catch(() => rigCache.delete(catalog.root));
  return value;
}

function parseFaceIndex(value, length) {
  const index = Number(value);
  if (!Number.isInteger(index) || index === 0) return -1;
  return index > 0 ? index - 1 : length + index;
}

function parsePropMeshes(text, requestedNames) {
  const vertices = [];
  const textureCoordinates = [];
  const meshes = new Map();
  let currentVertex;
  let currentMesh;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields[0] === "o") {
      const name = fields.slice(1).join(" ");
      currentMesh = requestedNames.has(name) ? { name, faces: [] } : null;
      if (currentMesh) meshes.set(name, currentMesh);
      currentVertex = undefined;
      continue;
    }
    if (fields[0] === "v") {
      const point = fields.slice(1, 4).map(Number);
      currentVertex = point.every(Number.isFinite) ? { point, weights: [] } : null;
      vertices.push(currentVertex);
      continue;
    }
    if (fields[0] === "vw" && currentVertex) {
      const weight = Number(fields[2]);
      if (fields[1] && Number.isFinite(weight) && weight !== 0) {
        currentVertex.weights.push({ bone: fields[1], weight });
      }
      continue;
    }
    if (fields[0] === "vt") {
      const uv = fields.slice(1, 3).map(Number);
      textureCoordinates.push(uv.every(Number.isFinite) ? uv : null);
      continue;
    }
    if (fields[0] !== "f" || !currentMesh || fields.length < 4) continue;
    const face = fields.slice(1, 4).map((field) => {
      const [vertexIndex, uvIndex] = field.split("/");
      return {
        vertex: parseFaceIndex(vertexIndex, vertices.length),
        uv: parseFaceIndex(uvIndex, textureCoordinates.length),
      };
    });
    if (face.every((entry) => entry.vertex >= 0 && entry.uv >= 0)) currentMesh.faces.push(face);
  }

  for (const mesh of meshes.values()) {
    mesh.faces = mesh.faces.map((face) => face.map((entry) => ({
      point: vertices[entry.vertex]?.point?.map((value) => value * MODEL_SCALE),
      weights: vertices[entry.vertex]?.weights || [],
      uv: textureCoordinates[entry.uv],
    }))).filter((face) => face.every((entry) => entry.point && entry.uv));
  }
  return meshes;
}

async function loadPropTexture(path) {
  let value = propTextureCache.get(path);
  if (value) return value;
  value = (async () => {
    const { data, info } = await sharp(path)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
  })();
  propTextureCache.set(path, value);
  value.catch(() => propTextureCache.delete(path));
  return value;
}

async function loadEmoteProps(catalog, emote) {
  const requested = (emote.meshes || []).filter((mesh) => mesh?.name);
  if (!requested.length) return [];
  const cacheKey = `${catalog.root}\0${emote.id}`;
  let value = propCache.get(cacheKey);
  if (value) return value;
  value = (async () => {
    const names = new Set(requested.map((mesh) => mesh.name));
    const found = new Map();
    for (const resource of catalog.props) {
      const path = resourcePath(catalog.root, resource);
      if (!path || !existsSync(path)) continue;
      const text = await cachedText(path);
      if (![...names].some((name) => text.includes(`o ${name}\n`) || text.includes(`o ${name}\r\n`))) continue;
      for (const [name, mesh] of parsePropMeshes(text, names)) found.set(name, mesh);
      if ([...names].every((name) => found.has(name))) break;
    }

    return Promise.all(requested.map(async ({ name, show_at: showAt = 0 }) => {
      const mesh = found.get(name);
      const descriptor = catalog.meshes[name];
      const texturePath = resourcePath(catalog.root, descriptor?.texture);
      if (!mesh || !texturePath || !existsSync(texturePath)) {
        throw new LunarEmoteError(`Prop assets for Lunar emote '${emote.name}' are incomplete (${name}).`, 424);
      }
      return {
        ...mesh,
        showAt: Number(showAt) || 0,
        texture: await loadPropTexture(texturePath),
      };
    }));
  })();
  propCache.set(cacheKey, value);
  value.catch(() => propCache.delete(cacheKey));
  return value;
}

export async function prepareEmote(identifier) {
  const { catalog, emote } = await catalogEmote(identifier);
  const [action, rig, props] = await Promise.all([
    loadAction(catalog, emote),
    loadRig(catalog),
    loadEmoteProps(catalog, emote),
  ]);
  return {
    ...publicEmote(emote),
    action,
    rig,
    props,
  };
}

function cubic(a, b, c, d, value) {
  const inverse = 1 - value;
  return inverse ** 3 * a
    + 3 * inverse ** 2 * value * b
    + 3 * inverse * value ** 2 * c
    + value ** 3 * d;
}

function bezierValue(left, right, time) {
  let minimum = 0;
  let maximum = 1;
  for (let index = 0; index < 24; index += 1) {
    const progress = (minimum + maximum) / 2;
    const x = cubic(left.time, left.right[0], right.left[0], right.time, progress);
    if (x < time) minimum = progress;
    else maximum = progress;
  }
  const progress = (minimum + maximum) / 2;
  return cubic(left.value, left.right[1], right.left[1], right.value, progress);
}

export function sampleKeyframes(keyframes, time) {
  if (!keyframes?.length) return 0;
  if (time <= keyframes[0].time) return keyframes[0].value;
  const last = keyframes[keyframes.length - 1];
  if (time >= last.time) return last.value;
  let rightIndex = 1;
  while (rightIndex < keyframes.length && keyframes[rightIndex].time < time) rightIndex += 1;
  const left = keyframes[rightIndex - 1];
  const right = keyframes[rightIndex];
  if (left.interpolation === "CONSTANT") return left.value;
  if (left.interpolation === "BEZIER") return bezierValue(left, right, time);
  const progress = (time - left.time) / (right.time - left.time);
  return left.value + (right.value - left.value) * progress;
}

function sampleBone(action, name, time) {
  const bone = action.bones.get(name);
  const sample = (property, fallback = 0) => ({
    x: bone?.[property]?.[0]?.length ? sampleKeyframes(bone[property][0], time) : fallback,
    y: bone?.[property]?.[1]?.length ? sampleKeyframes(bone[property][1], time) : fallback,
    z: bone?.[property]?.[2]?.length ? sampleKeyframes(bone[property][2], time) : fallback,
  });
  return {
    rotation: sample("rotation"),
    location: sample("location"),
    scale: sample("scale", 1),
  };
}

function addRotation(...rotations) {
  return rotations.reduce((result, rotation) => ({
    x: result.x + (rotation?.x || 0),
    y: result.y + (rotation?.y || 0),
    z: result.z + (rotation?.z || 0),
  }), { x: 0, y: 0, z: 0 });
}

function sampleBoneMatrices(prepared, time) {
  const current = new Map();
  const skin = {};
  const compute = (bone) => {
    if (current.has(bone.name)) return current.get(bone.name);
    const parent = bone.parent ? prepared.rig.bones.get(bone.parent) : null;
    const parentMatrix = parent ? compute(parent) : identity();
    const transform = sampleBone(prepared.action, bone.name, time);
    const animated = compose(
      translation(
        transform.location.x * MODEL_SCALE,
        transform.location.y * MODEL_SCALE,
        transform.location.z * MODEL_SCALE,
      ),
      rotationZ(transform.rotation.z),
      rotationY(transform.rotation.y),
      rotationX(transform.rotation.x),
      scaling(transform.scale.x, transform.scale.y, transform.scale.z),
    );
    const matrix = compose(parentMatrix, bone.relative, animated);
    current.set(bone.name, matrix);
    skin[bone.name] = multiply(matrix, bone.inverseBind);
    return matrix;
  };
  for (const bone of prepared.rig.bones.values()) compute(bone);
  return skin;
}

/** Samples Lunar's native Blender/Blockbuster action into the Minecraft rig. */
export function sampleEmotePose(prepared, normalizedFrame = 0) {
  const duration = Number(prepared.duration) || prepared.action.maximumFrame || 1;
  const phase = ((Number(normalizedFrame) || 0) % 1 + 1) % 1;
  const time = phase * duration;
  const anchor = sampleBone(prepared.action, "anchor", time);
  const body = sampleBone(prepared.action, "body", time);
  const lowBody = sampleBone(prepared.action, "low_body", time);

  return {
    emote: prepared.name,
    emoteTime: time,
    emoteProps: prepared.props,
    articulated: true,
    boneMatrices: sampleBoneMatrices(prepared, time),
    rootOffset: {
      x: anchor.location.x * MODEL_SCALE,
      y: anchor.location.y * MODEL_SCALE,
      z: anchor.location.z * MODEL_SCALE,
    },
    rootRotation: addRotation(anchor.rotation, body.rotation),
    upperRotation: lowBody.rotation,
    head: sampleBone(prepared.action, "head", time).rotation,
    rightArm: sampleBone(prepared.action, "right_arm", time).rotation,
    leftArm: sampleBone(prepared.action, "left_arm", time).rotation,
    rightForearm: sampleBone(prepared.action, "low_right_arm", time).rotation,
    leftForearm: sampleBone(prepared.action, "low_left_arm", time).rotation,
    rightLeg: sampleBone(prepared.action, "right_leg", time).rotation,
    leftLeg: sampleBone(prepared.action, "left_leg", time).rotation,
    rightLowerLeg: sampleBone(prepared.action, "low_leg_right", time).rotation,
    leftLowerLeg: sampleBone(prepared.action, "low_left_leg", time).rotation,
  };
}
