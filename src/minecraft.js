import { Buffer } from "node:buffer";
import { PNG } from "pngjs";

const PROFILE_TTL_MS = 5 * 60 * 1000;
const TEXTURE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MAX_SKIN_BYTES = 2 * 1024 * 1024;

const profileCache = new Map();
const textureCache = new Map();

export class MinecraftLookupError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "MinecraftLookupError";
    this.status = status;
  }
}

function cached(map, key) {
  const item = map.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return item.value;
}

function remember(map, key, value, ttl) {
  if (map.size >= MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
  map.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

function decodeTextures(properties) {
  const property = properties?.find((item) => item.name === "textures");
  if (!property?.value) return null;

  try {
    return JSON.parse(Buffer.from(property.value, "base64").toString("utf8"));
  } catch {
    throw new MinecraftLookupError("Mojang returned invalid texture metadata.");
  }
}

async function jsonRequest(url, notFoundMessage) {
  let response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": "skinstudio/1.0" },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new MinecraftLookupError("The Mojang profile service is unavailable.", 503);
  }

  if (response.status === 204 || response.status === 404) {
    throw new MinecraftLookupError(notFoundMessage, 404);
  }
  if (!response.ok) {
    throw new MinecraftLookupError(`Mojang returned HTTP ${response.status}.`, 502);
  }
  return response.json();
}

export async function resolvePlayer(player) {
  const key = player.toLowerCase();
  const fromCache = cached(profileCache, key);
  if (fromCache) return fromCache;

  const compactUuid = player.replaceAll("-", "");
  let uuid;
  let name = player;

  if (/^[0-9a-fA-F]{32}$/.test(compactUuid)) {
    uuid = compactUuid.toLowerCase();
  } else {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(player)) {
      throw new MinecraftLookupError("Player must be a Java username or UUID.", 400);
    }
    const lookup = await jsonRequest(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(player)}`,
      `Minecraft player '${player}' was not found.`,
    );
    uuid = lookup.id;
    name = lookup.name;
  }

  const session = await jsonRequest(
    `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
    `Minecraft profile '${player}' was not found.`,
  );
  const metadata = decodeTextures(session.properties);
  const skin = metadata?.textures?.SKIN;

  if (!skin?.url) {
    throw new MinecraftLookupError(`Minecraft player '${player}' has no skin texture.`, 404);
  }

  const textureUrl = new URL(skin.url);
  if (!["http:", "https:"].includes(textureUrl.protocol) || textureUrl.hostname !== "textures.minecraft.net") {
    throw new MinecraftLookupError("Mojang returned an untrusted texture URL.");
  }
  // Mojang still puts an http:// URL into some signed texture payloads even
  // though the texture CDN supports HTTPS. Upgrade it before downloading.
  textureUrl.protocol = "https:";

  const result = {
    uuid,
    name: session.name || name,
    textureUrl: textureUrl.toString(),
    slim: skin.metadata?.model === "slim",
  };
  remember(profileCache, key, result, PROFILE_TTL_MS);
  remember(profileCache, uuid, result, PROFILE_TTL_MS);
  return result;
}

export async function downloadSkin(url) {
  const fromCache = cached(textureCache, url);
  if (fromCache) return fromCache;

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new MinecraftLookupError("The Minecraft texture service is unavailable.", 503);
  }
  if (!response.ok) {
    throw new MinecraftLookupError(`Texture service returned HTTP ${response.status}.`, 502);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_SKIN_BYTES) {
    throw new MinecraftLookupError("Skin texture is too large.", 502);
  }
  const value = Buffer.from(await response.arrayBuffer());
  if (value.length > MAX_SKIN_BYTES) {
    throw new MinecraftLookupError("Skin texture is too large.", 502);
  }
  remember(textureCache, url, value, TEXTURE_TTL_MS);
  return value;
}

export async function resolveSkinSource(identifier) {
  if (/^[0-9a-fA-F]{64}$/.test(identifier)) {
    const hash = identifier.toLowerCase();
    const textureUrl = `https://textures.minecraft.net/texture/${hash}`;
    return {
      skin: await downloadSkin(textureUrl),
      profile: { name: hash, uuid: null, textureUrl, slim: false, textureHash: hash },
    };
  }

  const profile = await resolvePlayer(identifier);
  return { skin: await downloadSkin(profile.textureUrl), profile };
}

export function processSkin(skinBuffer) {
  let source;
  try {
    source = PNG.sync.read(skinBuffer);
  } catch {
    throw new MinecraftLookupError("The skin texture is not a valid PNG image.", 502);
  }
  if (source.width % 64 !== 0) {
    throw new MinecraftLookupError("Skin width must be 64px or a multiple of 64px.", 502);
  }
  const scale = source.width / 64;
  const legacy = source.height === 32 * scale;
  if (!legacy && source.height !== 64 * scale) {
    throw new MinecraftLookupError("Skin texture must use the 64x64 or legacy 64x32 layout.", 502);
  }

  let output = source;
  if (legacy) {
    output = new PNG({ width: source.width, height: source.width });
    source.data.copy(output.data, 0, 0, source.data.length);

    const copyRegion = (sourceX, sourceY, targetX, targetY, width, height) => {
      for (let y = 0; y < height * scale; y += 1) {
        const from = (((sourceY * scale + y) * source.width) + sourceX * scale) * 4;
        const to = (((targetY * scale + y) * output.width) + targetX * scale) * 4;
        source.data.copy(output.data, to, from, from + width * scale * 4);
      }
    };
    copyRegion(0, 16, 16, 48, 16, 16);
    copyRegion(40, 16, 32, 48, 16, 16);
  }

  const opaqueRegions = [
    [0, 0, 32, 16],
    [0, 16, 16, 16],
    [16, 16, 24, 16],
    [40, 16, 16, 16],
    [16, 48, 32, 16],
  ];
  for (const [x, y, width, height] of opaqueRegions) {
    for (let row = y * scale; row < (y + height) * scale; row += 1) {
      for (let column = x * scale; column < (x + width) * scale; column += 1) {
        output.data[(row * output.width + column) * 4 + 3] = 255;
      }
    }
  }
  return PNG.sync.write(output, { colorType: 6, inputColorType: 6 });
}
