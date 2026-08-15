import http from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { encodeApng } from "./apng.js";
import { encodeGif } from "./gif.js";
import {
  DEFAULT_ANIMATION_TIME,
  getCosmetic,
  listCosmetics,
  LunarCosmeticError,
  prepareCosmetics,
} from "./cosmetics.js";
import {
  getEmote,
  listEmotes,
  LunarEmoteError,
  prepareEmote,
} from "./emotes.js";
import {
  MinecraftLookupError,
  processSkin,
  resolveSkinSource,
} from "./minecraft.js";
import { listPoses, POSES } from "./poses.js";
import { renderFace, renderSkin } from "./renderer.js";

const MAX_BODY_SIZE = 2 * 1024 * 1024;

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value, null, 2));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "access-control-allow-origin": "*",
    ...headers,
  });
  response.end(body);
}

function sendImage(response, body, contentType = "image/png", headers = {}) {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "access-control-allow-origin": "*",
    ...headers,
  });
  response.end(body);
}

function numberParameter(searchParams, name, fallback, minimum, maximum) {
  const raw = searchParams.get(name);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RequestError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function booleanParameter(searchParams, name, fallback) {
  const raw = searchParams.get(name);
  if (raw == null) return fallback;
  if (["1", "true", "yes"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no"].includes(raw.toLowerCase())) return false;
  throw new RequestError(`${name} must be true or false.`);
}

function downloadHeaders(options, subject = "skin") {
  if (!options.download) return {};
  const safeSubject = String(subject)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "skin";
  const safePose = String(options.emote?.name || options.pose || "render")
    .replace(/[^a-zA-Z0-9_-]+/g, "-");
  const extension = options.format === "gif" ? "gif" : "png";
  return {
    "content-disposition": `attachment; filename="${safeSubject}-${safePose}.${extension}"`,
  };
}

function cosmeticIds(searchParams) {
  const values = [
    ...searchParams.getAll("cosmetic"),
    ...searchParams.getAll("cosmetics"),
  ].flatMap((value) => value.split(","));
  const ids = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      throw new RequestError(`Invalid Lunar cosmetic id '${value}'.`);
    }
    const id = Number(value);
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > 16) throw new RequestError("At most 16 Lunar cosmetics can be rendered at once.");
  return ids;
}

async function addCosmetics(options, searchParams, fullBody) {
  const ids = cosmeticIds(searchParams);
  if (!ids.length) return options;
  if (!fullBody) {
    throw new RequestError("Lunar cosmetics are only supported by full-body render modes.");
  }
  return {
    ...options,
    cosmeticIds: ids,
    cosmetics: await prepareCosmetics(ids, { slim: options.slim }),
  };
}

async function addEmote(options, searchParams, fullBody) {
  const identifier = searchParams.get("emote");
  if (identifier == null || !identifier.trim()) return options;
  if (!fullBody) {
    throw new RequestError("Lunar emotes are only supported by full-body render modes.");
  }
  const emote = await prepareEmote(identifier);
  const durationSeconds = emote.duration / 20;
  const fpsExplicit = searchParams.has("fps");
  let fps = fpsExplicit ? options.fps : 20;
  let frames = options.frames;
  if (!searchParams.has("frames")) {
    frames = Math.max(2, Math.round(durationSeconds * fps));
    // A long emote (e.g. Renegade at 13.3s) can need more frames than the
    // 120 ceiling allows at its native tick rate. Capping the frame count
    // alone while keeping fps fixed would squeeze the whole animation into
    // fewer real-time seconds than it actually takes, playing it back too
    // fast. Lower fps instead so `frames / fps` still matches the emote's
    // real duration, unless the caller pinned fps explicitly.
    if (frames > 120) {
      frames = 120;
      if (!fpsExplicit) fps = Math.max(1, Math.min(30, Math.round(frames / durationSeconds)));
    }
  }
  return {
    ...options,
    emote,
    fps,
    frames,
  };
}

async function addRenderAssets(options, searchParams, fullBody) {
  return addEmote(await addCosmetics(options, searchParams, fullBody), searchParams, fullBody);
}

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function renderOptions(searchParams, detectedSlim = false, routeFormat) {
  const animationRequested = searchParams.has("animated")
    ? booleanParameter(searchParams, "animated", false)
    : booleanParameter(searchParams, "animate", false);
  const gifRequested = booleanParameter(searchParams, "gif", false);
  const format = (routeFormat || searchParams.get("format") || (gifRequested
    ? "gif"
    : (animationRequested ? "apng" : "png"))).toLowerCase();
  if (!["png", "apng", "gif"].includes(format)) {
    throw new RequestError("format must be png, apng, or gif.");
  }
  const animated = format !== "png";
  const pose = searchParams.get("pose") || searchParams.get("type") || "showcase";
  if (!Object.hasOwn(POSES, pose)) {
    throw new RequestError(`Unknown pose '${pose}'. Try GET /v1/poses.`);
  }

  const slimRaw = searchParams.get("slim");
  let slim = detectedSlim;
  if (slimRaw && slimRaw !== "auto") {
    slim = booleanParameter(searchParams, "slim", detectedSlim);
  }

  const antialias = numberParameter(searchParams, "antialias", undefined, 1, 2);
  if (antialias != null && !Number.isInteger(antialias)) {
    throw new RequestError("antialias must be 1 or 2.");
  }
  const projection = searchParams.get("projection") || "orthographic";
  if (!["isometric", "perspective", "orthographic"].includes(projection)) {
    throw new RequestError("projection must be isometric, perspective, or orthographic.");
  }
  const size = numberParameter(searchParams, "size", animated ? 512 : 1024, 64, 2048);
  if (!Number.isInteger(size)) throw new RequestError("size must be a whole number.");
  const portraitWidth = searchParams.has("size") ? size : Math.round(size * 0.86);
  const width = numberParameter(searchParams, "width", portraitWidth, 64, 2048);
  const height = numberParameter(searchParams, "height", size, 64, 2048);
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new RequestError("width and height must be whole numbers.");
  }
  const background = searchParams.get("background") || "transparent";
  if (background !== "transparent" && !/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(background)) {
    throw new RequestError("background must be 'transparent', RRGGBB, or RRGGBBAA.");
  }
  const layerStyle = searchParams.get("layers") || searchParams.get("layerStyle") || "voxel";
  if (!["voxel", "flat", "none"].includes(layerStyle)) {
    throw new RequestError("layers must be voxel, flat, or none.");
  }
  const overlay = booleanParameter(searchParams, "overlay", true) && layerStyle !== "none";
  const view = searchParams.get("view") || "front";
  if (!["front", "back"].includes(view)) {
    throw new RequestError("view must be front or back.");
  }

  const options = {
    pose,
    size,
    width,
    height,
    frame: numberParameter(searchParams, "frame", undefined, 0, 1),
    yaw: numberParameter(searchParams, "yaw", undefined, -180, 180),
    pitch: numberParameter(searchParams, "pitch", undefined, -45, 45),
    padding: numberParameter(searchParams, "padding", 0.1, 0, 0.3),
    antialias,
    overlay,
    layerStyle,
    layerDepth: numberParameter(searchParams, "layerDepth", 1, 0.25, 2),
    animated,
    format,
    animateCosmetics: searchParams.has("animateCosmetics")
      ? booleanParameter(searchParams, "animateCosmetics", animated)
      : booleanParameter(searchParams, "cosmeticAnimation", animated),
    download: searchParams.has("download")
      ? booleanParameter(searchParams, "download", false)
      : booleanParameter(searchParams, "attachment", false),
    frames: numberParameter(searchParams, "frames", 12, 2, 120),
    fps: numberParameter(searchParams, "fps", 12, 1, 30),
    shading: booleanParameter(searchParams, "shading", true),
    shadow: booleanParameter(searchParams, "shadow", true),
    dropShadow: booleanParameter(searchParams, "dropShadow", false),
    background,
    isometric: projection === "isometric",
    perspective: projection === "perspective",
    cameraDistance: numberParameter(searchParams, "cameraDistance", 72, 48, 160),
    fov: numberParameter(searchParams, "fov", undefined, 10, 120),
    slim,
    view,
  };
  if (view === "back" && !searchParams.has("yaw")) options.yaw = 180;
  if (searchParams.has("steve")) options.slim = false;
  else if (searchParams.has("alex")) options.slim = true;
  if (searchParams.has("noshading")) {
    options.shading = false;
    options.shadow = false;
  }
  if (searchParams.has("nolayers")) {
    options.overlay = false;
    options.layerStyle = "none";
  }
  return options;
}

function compatibilityOptions(mode, searchParams, detectedSlim, routeFormat) {
  const options = renderOptions(searchParams, detectedSlim, routeFormat);
  const hasCustomPose = searchParams.has("pose") || searchParams.has("type");
  const hasCustomDimensions = searchParams.has("size")
    || searchParams.has("width")
    || searchParams.has("height");

  if (searchParams.has("steve")) options.slim = false;
  else if (searchParams.has("alex")) options.slim = true;
  if (searchParams.has("noshading")) {
    options.shading = false;
    options.shadow = false;
  }
  if (searchParams.has("nolayers")) {
    options.overlay = false;
    options.layerStyle = "none";
  }

  if (!hasCustomPose) options.pose = ["fullbody", "fullbodyback"].includes(mode)
    ? "showcase"
    : "standing";
  if (["head", "headiso", "face"].includes(mode)) options.mode = "head";
  else if (mode === "bust") options.mode = "bust";
  else options.mode = "fullbody";

  if (options.overlay && !searchParams.has("layers") && !searchParams.has("layerStyle")) {
    options.layerStyle = "flat";
  }

  if (mode === "head") {
    options.isometric = false;
    options.perspective = true;
    options.yaw = searchParams.has("yaw") ? options.yaw : -25;
    options.pitch = searchParams.has("pitch") ? options.pitch : 15;
    options.cameraDistance = searchParams.has("cameraDistance") ? options.cameraDistance : 19;
    options.fov = searchParams.has("fov") ? options.fov : 45;
    options.cameraTarget = [0, 28, 0];
    if (!searchParams.has("antialias")) options.antialias = 4;
  }

  if (mode === "frontfull") {
    options.isometric = false;
    options.perspective = false;
    options.yaw = searchParams.has("yaw") ? options.yaw : 0;
    options.pitch = searchParams.has("pitch") ? options.pitch : 0;
    options.shading = searchParams.has("shading") ? options.shading : false;
    options.shadow = false;
  }
  if (mode === "face") {
    options.isometric = false;
    options.perspective = false;
    options.yaw = 0;
    options.pitch = 0;
    options.padding = 0;
    options.shading = false;
    options.shadow = false;
    options.dropShadow = false;
    if (options.overlay) options.layerStyle = "flat";
  }
  if (["fullbodyiso", "headiso"].includes(mode)) {
    options.isometric = true;
    options.perspective = false;
  }
  if (mode === "fullbodyback") {
    options.isometric = false;
    options.perspective = false;
    options.yaw = searchParams.has("yaw") ? options.yaw : 180;
    options.pitch = searchParams.has("pitch") ? options.pitch : 12;
    options.view = "back";
  }

  if (!hasCustomDimensions) {
    const [width, height] = {
      bust: [768, 768],
      frontfull: [512, 1024],
      fullbodyiso: [1024, 1024],
      fullbodyback: [880, 1024],
      head: [512, 512],
      face: [512, 512],
      headiso: [512, 512],
    }[mode] || [880, 1024];
    options.size = Math.max(width, height);
    options.width = width;
    options.height = height;
  }
  return options;
}

async function renderOutput(skin, options) {
  if (!options.animated) {
    return { body: renderSkin(skin, options), contentType: "image/png" };
  }
  if (!Number.isInteger(options.frames) || !Number.isInteger(options.fps)) {
    throw new RequestError("frames and fps must be whole numbers.");
  }
  const startFrame = options.frame ?? 0;
  // Cosmetics are otherwise baked once and reused for every frame, so a
  // life_time-driven aura (falling leaves, a swirling wind ring, ...) would
  // render as the exact same pose in every frame of the GIF/APNG. Re-baking
  // per frame lets that internal motion actually play out, matching how
  // cloaks/wings already animate via `frame`.
  //
  // The oscillating clock (spins, flaps, sways) ping-pongs back to its start
  // value across the sequence instead of just counting up, so the last frame
  // ends up close to the first and the GIF loops seamlessly instead of
  // snapping when a viewer repeats it. The swarm fall clock (Money Aura,
  // Autumn Leaf Aura) stays monotonic since it wants a one-way fall with its
  // own built-in respawn-at-top wrap, not a reversal.
  //
  // The formulas themselves (e.g. a wing's sin(life_time * ...)) assume
  // life_time is real elapsed seconds, so the ping-pong's half-swing is set
  // to half the GIF's actual playback duration - one lap there and back
  // covers exactly one playback's worth of life_time, keeping the flap/spin
  // speed close to how fast it actually runs rather than a fixed swing that
  // reads faster on a short clip and slower on a long one.
  const animateAuraTimeline = options.animateCosmetics && options.cosmeticIds?.length > 0;
  const playbackSeconds = options.frames / options.fps;
  const oscillationSpanSeconds = playbackSeconds / 2;
  const frames = [];
  for (let index = 0; index < options.frames; index += 1) {
    const frameOptions = {
      ...options,
      frame: (startFrame + index / options.frames) % 1,
      stableFraming: true,
    };
    if (animateAuraTimeline) {
      const cycle = index / options.frames;
      const bounce = 1 - Math.abs(2 * cycle - 1);
      frameOptions.cosmetics = await prepareCosmetics(options.cosmeticIds, {
        slim: options.slim,
        lifeTime: DEFAULT_ANIMATION_TIME + bounce * oscillationSpanSeconds,
        fallTime: DEFAULT_ANIMATION_TIME + index / options.fps,
      });
    }
    frames.push(renderSkin(skin, frameOptions));
  }
  if (options.format === "gif") {
    return {
      body: await encodeGif(frames, { fps: options.fps }),
      contentType: "image/gif",
    };
  }
  return { body: encodeApng(frames, { fps: options.fps }), contentType: "image/apng" };
}

async function compatibilityOutput(mode, skin, options) {
  if (mode === "face") {
    return { body: renderFace(skin, options), contentType: "image/png" };
  }
  return renderOutput(skin, options);
}

function profileHeaders(profile) {
  const headers = { "x-minecraft-player": profile.name };
  if (profile.uuid) headers["x-minecraft-uuid"] = profile.uuid;
  if (profile.textureHash) headers["x-minecraft-texture-hash"] = profile.textureHash;
  return headers;
}

function cosmeticHeaders(options) {
  if (!options.cosmeticIds?.length) return {};
  return { "x-lunar-cosmetics": options.cosmeticIds.join(",") };
}

function emoteHeaders(options) {
  if (!options.emote) return {};
  return {
    "x-lunar-emote": `${options.emote.id}:${options.emote.name}`,
    "x-lunar-emote-duration": String(options.emote.duration),
  };
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_SIZE) throw new RequestError("PNG body is too large.", 413);
    chunks.push(chunk);
  }
  if (length === 0) throw new RequestError("Send the skin PNG as the raw request body.");
  return Buffer.concat(chunks);
}

async function route(request, response) {
  if (!request.url) throw new RequestError("Invalid request.");
  const url = new URL(request.url, "http://localhost");
  const path = decodeURIComponent(url.pathname);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && path === "/v1/poses") {
    sendJson(response, 200, { poses: listPoses() });
    return;
  }
  if (request.method === "GET" && path === "/v1/emotes") {
    const offset = numberParameter(url.searchParams, "offset", 0, 0, 100_000);
    const limit = numberParameter(url.searchParams, "limit", 100, 1, 500);
    if (!Number.isInteger(offset) || !Number.isInteger(limit)) {
      throw new RequestError("offset and limit must be whole numbers.");
    }
    const looping = url.searchParams.has("looping")
      ? booleanParameter(url.searchParams, "looping", false)
      : undefined;
    sendJson(response, 200, {
      emotes: await listEmotes({
        query: url.searchParams.get("q") || undefined,
        looping,
        offset,
        limit,
      }),
    });
    return;
  }
  const emoteMatch = path.match(/^\/v1\/emotes\/([^/]+)$/);
  if (request.method === "GET" && emoteMatch) {
    sendJson(response, 200, { emote: await getEmote(emoteMatch[1]) });
    return;
  }
  if (request.method === "GET" && path === "/v1/cosmetics") {
    const available = url.searchParams.has("available")
      ? booleanParameter(url.searchParams, "available", true)
      : undefined;
    const offset = numberParameter(url.searchParams, "offset", 0, 0, 100_000);
    const limit = numberParameter(url.searchParams, "limit", 100, 1, 500);
    if (!Number.isInteger(offset) || !Number.isInteger(limit)) {
      throw new RequestError("offset and limit must be whole numbers.");
    }
    sendJson(response, 200, {
      cosmetics: await listCosmetics({
        category: url.searchParams.get("category") || undefined,
        query: url.searchParams.get("q") || undefined,
        available,
        offset,
        limit,
      }),
    });
    return;
  }
  const cosmeticMatch = path.match(/^\/v1\/cosmetics\/(\d+)$/);
  if (request.method === "GET" && cosmeticMatch) {
    sendJson(response, 200, { cosmetic: await getCosmetic(Number(cosmeticMatch[1])) });
    return;
  }
  if (request.method === "GET" && path === "/") {
    sendJson(response, 200, {
      name: "SkinStudio",
      examples: [
        "/v1/render/Notch.png?type=walking&size=512",
        "/v1/render/Notch.gif?pose=waving&frames=12&fps=12",
        "/v1/render/Notch.gif?emote=10&frames=16&fps=12&download=true",
        "/v1/render/Notch.gif?pose=running&cosmetic=1&view=back",
        "/v1/render/069a79f444e94726a5befca90e38aaf5?pose=cheering",
        "/v1/render/Notch.png?cosmetic=1&size=512",
        "/fullbodyback/Notch?cosmetic=1&size=512",
      ],
      upload: "POST a raw image/png body to /v1/render?pose=crouching",
      cosmetics: {
        catalog: "/v1/cosmetics",
        byId: "/v1/cosmetics/{id}",
        render: "/v1/render/{player}.png?cosmetic={id}",
      },
      emotes: {
        catalog: "/v1/emotes",
        byIdOrName: "/v1/emotes/{id|name}",
        gif: "/v1/render/{player}.gif?emote={id|name}",
      },
      poses: listPoses().map((pose) => pose.name),
      compatibleEndpoints: [
        "/fullbody/{name|uuid|textureHash}",
        "/bust/{name|uuid|textureHash}",
        "/frontfull/{name|uuid|textureHash}",
        "/fullbodyiso/{name|uuid|textureHash}",
        "/fullbodyback/{name|uuid|textureHash}",
        "/head/{name|uuid|textureHash}",
        "/face/{name|uuid|textureHash}",
        "/headiso/{name|uuid|textureHash}",
        "/skin/{name|uuid|textureHash}",
      ],
    });
    return;
  }

  const compatibilityMatch = path.match(
    /^\/(?:v1\/)?(fullbodyback|backfull|fullbody|bust|frontfull|fullbodyiso|head|face|headiso|skin)\/([^/]+?)(?:\.(png|gif))?$/,
  );
  if (request.method === "GET" && compatibilityMatch) {
    const [, requestedMode, identifier, extension] = compatibilityMatch;
    const mode = requestedMode === "backfull" ? "fullbodyback" : requestedMode;
    const { skin, profile } = await resolveSkinSource(identifier);
    const headers = {
      "cache-control": "public, max-age=300",
      ...profileHeaders(profile),
    };
    if (mode === "skin") {
      if (cosmeticIds(url.searchParams).length) {
        throw new RequestError("Lunar cosmetics cannot be used with the raw skin endpoint.");
      }
      if (url.searchParams.has("emote")) {
        throw new RequestError("Lunar emotes cannot be used with the raw skin endpoint.");
      }
      sendImage(response, url.searchParams.has("process") ? processSkin(skin) : skin, "image/png", headers);
      return;
    }
    const options = await addRenderAssets(
      compatibilityOptions(mode, url.searchParams, profile.slim, extension === "gif" ? "gif" : undefined),
      url.searchParams,
      ["fullbody", "frontfull", "fullbodyiso", "fullbodyback"].includes(mode),
    );
    const output = await compatibilityOutput(mode, skin, options);
    sendImage(response, output.body, output.contentType, {
      ...headers,
      ...cosmeticHeaders(options),
      ...emoteHeaders(options),
      ...downloadHeaders(options, profile.name),
    });
    return;
  }

  const compatibilityUploadMatch = path.match(
    /^\/(?:v1\/)?(fullbodyback|backfull|fullbody|bust|frontfull|fullbodyiso|head|face|headiso|skin)$/,
  );
  if (request.method === "POST" && compatibilityUploadMatch) {
    const contentType = request.headers["content-type"]?.split(";", 1)[0];
    if (contentType !== "image/png" && contentType !== "application/octet-stream") {
      throw new RequestError("Content-Type must be image/png.", 415);
    }
    const requestedMode = compatibilityUploadMatch[1];
    const mode = requestedMode === "backfull" ? "fullbodyback" : requestedMode;
    const skin = await readBody(request);
    if (mode === "skin") {
      if (cosmeticIds(url.searchParams).length) {
        throw new RequestError("Lunar cosmetics cannot be used with the raw skin endpoint.");
      }
      if (url.searchParams.has("emote")) {
        throw new RequestError("Lunar emotes cannot be used with the raw skin endpoint.");
      }
      sendImage(
        response,
        url.searchParams.has("process") ? processSkin(skin) : skin,
        "image/png",
        { "cache-control": "no-store" },
      );
      return;
    }
    const options = await addRenderAssets(
      compatibilityOptions(mode, url.searchParams, false),
      url.searchParams,
      ["fullbody", "frontfull", "fullbodyiso", "fullbodyback"].includes(mode),
    );
    const output = await compatibilityOutput(mode, skin, options);
    sendImage(response, output.body, output.contentType, {
      "cache-control": "no-store",
      ...cosmeticHeaders(options),
      ...emoteHeaders(options),
      ...downloadHeaders(options),
    });
    return;
  }

  const playerMatch = path.match(/^\/v1\/render\/([^/]+?)(?:\.(png|gif))?$/);
  if (request.method === "GET" && playerMatch) {
    const player = playerMatch[1];
    const { skin, profile } = await resolveSkinSource(player);
    const options = await addRenderAssets(
      renderOptions(url.searchParams, profile.slim, playerMatch[2] === "gif" ? "gif" : undefined),
      url.searchParams,
      true,
    );
    const output = await renderOutput(skin, options);
    sendImage(response, output.body, output.contentType, {
      "cache-control": "public, max-age=300",
      ...profileHeaders(profile),
      ...cosmeticHeaders(options),
      ...emoteHeaders(options),
      ...downloadHeaders(options, profile.name),
    });
    return;
  }

  if (request.method === "POST" && path === "/v1/render") {
    const contentType = request.headers["content-type"]?.split(";", 1)[0];
    if (contentType !== "image/png" && contentType !== "application/octet-stream") {
      throw new RequestError("Content-Type must be image/png.", 415);
    }
    const skin = await readBody(request);
    const options = await addRenderAssets(renderOptions(url.searchParams), url.searchParams, true);
    const output = await renderOutput(skin, options);
    sendImage(response, output.body, output.contentType, {
      "cache-control": "no-store",
      ...cosmeticHeaders(options),
      ...emoteHeaders(options),
      ...downloadHeaders(options),
    });
    return;
  }

  throw new RequestError("Route not found.", 404);
}

export function createServer() {
  return http.createServer((request, response) => {
    route(request, response).catch((error) => {
      const knownError = error instanceof RequestError
        || error instanceof MinecraftLookupError
        || error instanceof LunarCosmeticError
        || error instanceof LunarEmoteError;
      const status = knownError ? error.status : 500;
      if (!knownError) console.error(error);
      if (!response.headersSent) {
        sendJson(response, status, {
          error: error.message || "Internal server error.",
          ...(error.details ? { details: error.details } : {}),
        });
      } else {
        response.destroy();
      }
    });
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => {
    console.log(`SkinStudio listening on http://localhost:${port}`);
  });
}
