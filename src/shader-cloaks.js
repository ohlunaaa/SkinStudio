// Lunar's shader cloaks, ported from their GLSL.
//
// Lunar draws these cloaks with a fragment shader every frame - the list is
// assets/lunar/cosmetics/indexes/shader_textures.json, keyed by the cloak's
// texture. The .webp the catalogue names is only a baked placeholder, so
// without a port a render shows one frozen moment of it, and the catalogue
// marks every one of them `animated: false`.
//
// Each port follows its .fsh line for line. GLSL semantics that differ from
// JS are kept on purpose: `mod` floors (JS `%` truncates), and `uv` runs
// top-down across the whole 22x17 cloak texture, as it does in Lunar.
//
// Uniforms a render has no source for are fixed: VelocitySmooth is a standing
// player (0), BiomeColor is plains foliage, LunarPlusColor Lunar's own blue.
// A cloak added to shader_textures.json without a port here renders its
// placeholder, exactly as before.

const fract = (x) => x - Math.floor(x);
const mod = (x, y) => x - y * Math.floor(x / y);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize3 = (a) => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 0 ? scale3(a, 1 / length) : [0, 0, 0];
};

function hsv2rgb(h, s, v) {
  return [1, 2 / 3, 1 / 3].map((k) => {
    const p = Math.abs(fract(h + k) * 6 - 3);
    return v * mix(1, clamp(p - 1, 0, 1), s);
  });
}

// cloakPosToUv / getImage, shared by the staff cloaks: an image pinned at a
// cloak-pixel position, square in OUTPUT pixels, transparent outside it.
function getImage(ctx, sampler, [x, y], sizeX) {
  const sizeY = sizeX * ctx.outSize[0] / ctx.outSize[1];
  const [u, v] = ctx.uv;
  if (u < x || v < y || u > x + sizeX || v > y + sizeY) return [0, 0, 0, 0];
  return ctx.sample(sampler, (u - x) / sizeX, (v - y) / sizeY);
}
const cloakPos = (x, y) => [x / 22, y / 17];

function testerplusRainbow(ctx) {
  const T = ctx.time;
  const [u, v] = ctx.uv;
  const remapX = (x) => clamp(10 / 9.5 - 0.1 * Math.abs(x - 11.5), 0, 1);
  let y = Math.max(v, 1 / 16);
  let x = remapX(u * 22);
  if (u > 0.5 && v < 1 / 17) {
    x = remapX((u - 0.45) * 22);
    y = 1;
  }
  const hue = mod(Math.cos(T * 0.25) * 0.5 + x + 0.1 * Math.cos(T * 0.25 * 20 + y * 20), 1);
  return [...hsv2rgb(hue, 1, 1), 1];
}

function lunarplusGlow(ctx) {
  const [px, py] = [ctx.outSize[0] * ctx.uv[0], ctx.outSize[1] * ctx.uv[1]];
  const uvLogo = [(px - 80) / 200, (py - 150) / 200];
  const dx = px - 180;
  const dy = (py - 270) * 0.70710678;
  const r = dx * dx + dy * dy;
  const veloMul = clamp(ctx.velocity * 0.125, 0, 1);
  const glow = ctx.lunarPlusColor;
  const grey = dot3(glow, [0.21, 0.71, 0.07]);
  const bgFalloff = 1 - clamp(r / 30000, 0, 1);
  const glowStrength = 0.1 + veloMul * (0.1 + (1 - grey) * 0.2);
  const inside = uvLogo[0] >= 0 && uvLogo[0] <= 1 && uvLogo[1] >= 0 && uvLogo[1] <= 1;
  const logo = inside ? ctx.sample("LunarLogo", uvLogo[0], uvLogo[1]) : [0, 0, 0, 0];
  return [0, 1, 2].map((i) => {
    const pixel = logo[i] * mix(logo[i], glow[i], veloMul);
    return mix(glow[i] * glowStrength * bgFalloff, pixel, logo[3]);
  }).concat(1);
}

// The two staff holograms share everything up to the final colour.
function hologram(ctx, logoAt, logoSize) {
  const N = normalize3(ctx.normal);
  const lunar = getImage(ctx, "LunarLogo", logoAt, logoSize);
  const ndv = Math.max(N[2], 0);
  const viewTerm = Math.pow(1 - ndv, 2) * 0.7 + Math.pow(ndv, 1.2) * 0.6;
  const diagLength = Math.hypot(1, 0.7);
  const diagCoord = (ctx.uv[0] + ctx.uv[1] * 0.7) / diagLength;
  const film = diagCoord * 6 + ndv * 8 + ctx.time * 0.5;
  return { alpha: lunar[3], viewTerm, film };
}

function staffDev(ctx) {
  const { alpha, viewTerm, film } = hologram(ctx, cloakPos(1, 4), 10 / 22);
  const t = 0.5 + 0.5 * Math.cos(film);
  const clr1 = [0.1, 0.1, 0.1];
  const clr2 = [0.33, 1, 1];
  return [0, 1, 2].map((i) => {
    const dark = mix(clr1[i], clr2[i], alpha);
    const light = mix(clr1[i], clr2[i], 1 - alpha);
    const holo = mix(dark, light, t) * viewTerm;
    return holo * holo * 2;
  }).concat(1);
}

function staffHolographic(ctx) {
  const { alpha, viewTerm, film } = hologram(ctx, cloakPos(2, 5), 8 / 22);
  return [0, 2.094, 4.188].map((phase) => {
    const spectrum = Math.pow(0.5 + 0.5 * Math.cos(phase + film + alpha * 2), 0.85);
    return 1 - spectrum * viewTerm;
  }).concat(1);
}

const normalDebug = (ctx) => [...ctx.normal, 1];
const positionDebug = (ctx) => [...ctx.worldPos, 1];
const screenDebug = (ctx) => [ctx.screenUV[0], ctx.screenUV[1], 1, 1];

// hash(vec2(i, 0.19343493)).x for i = 1..15 - constant per layer, so the
// rotation is worked out once. Float64 here and float32 on a GPU disagree past
// sin(x) * 43758, so the layer angles are Lunar's in kind, not bit for bit.
const END_LAYERS = Array.from({ length: 15 }, (_, index) => {
  const i = index + 1;
  const angle = (16 - i) * fract(Math.sin(i * 127.1 + 0.19343493 * 311.7) * 43758.5453);
  return { i, sin: Math.sin(angle), cos: Math.cos(angle), weight: 1 - i / 16 };
});
const END_COLORS = [
  [0.10196, 0.54117, 0.6],
  [0.48235, 0.44705, 0.69803],
  [0.29411, 0.56862, 0.51372],
];

function devEndPortal(ctx) {
  const [sx, sy] = ctx.screenUV;
  const lunar = getImage(ctx, "LunarLogo", cloakPos(2, 4.5), 8 / 22);
  const base = 1 + 1.5 * lunar[3];
  const col = [0.0156863 * base, 0.0470588 * base, 0.0823529 * base];
  const move = ctx.time * 0.01;
  for (const { i, sin: s, cos: c, weight } of END_LAYERS) {
    // mat2(c, -s, s, c) is column-major.
    const u = mod((c * sx + s * sy) * i * 0.8, 1);
    const v = mod((-s * sx + c * sy) * i * 0.8 + move, 1);
    const tex = ctx.sample("EndPortal", u, v);
    const tint = END_COLORS[i % 3];
    for (let k = 0; k < 3; k += 1) col[k] += tex[k] * tint[k] * weight;
  }
  return [...col, 1];
}

// Portal (endportal_bw): Dev End's layers in grey, without the logo, each
// layer scaled by i + DETAIL rather than i and brightened by BRIGHTNESS.
const PORTAL_GREYS = [0.4498, 0.5513, 0.6446];

function endPortalBw(ctx) {
  const [sx, sy] = ctx.screenUV;
  const col = [0.0429, 0.0429, 0.0429];
  const move = ctx.time * 0.01;
  for (const { i, sin: s, cos: c, weight } of END_LAYERS) {
    const u = mod((c * sx + s * sy) * (i + 2) * 0.8, 1);
    const v = mod((-s * sx + c * sy) * (i + 2) * 0.8 + move, 1);
    const tex = ctx.sample("EndPortal", u, v);
    const grey = PORTAL_GREYS[i % 3] * weight * 1.35;
    for (let k = 0; k < 3; k += 1) col[k] += tex[k] * grey;
  }
  return [...col, 1];
}

const leaves = (ctx) => {
  const l = ctx.sample("Leaves", ctx.uv[0], ctx.uv[1]);
  return [l[0] * ctx.biomeColor[0], l[1] * ctx.biomeColor[1], l[2] * ctx.biomeColor[2], l[3]];
};

const FACE_MIN = [1 / 22, 1 / 16];
const FACE_MAX = [11 / 22, 16 / 16];

function staffInfinity(ctx) {
  const { dPdx, dPdy, dUx, dUy } = ctx.derivatives;
  const [u, v] = ctx.uv;
  if (u < FACE_MIN[0] || u > FACE_MAX[0] || v < FACE_MIN[1] || v > FACE_MAX[1]) return [0, 0, 0, 1];
  const f = [
    ((u - FACE_MIN[0]) / (FACE_MAX[0] - FACE_MIN[0])) * 2 - 1,
    ((v - FACE_MIN[1]) / (FACE_MAX[1] - FACE_MIN[1])) * 2 - 1,
  ];
  let N = normalize3(ctx.normal);
  const V = normalize3(scale3(ctx.worldPos, -1));
  if (dot3(N, V) < 0) N = scale3(N, -1);

  const det = dUx[0] * dUy[1] - dUx[1] * dUy[0];
  if (det === 0) return [0, 0, 0, 1];
  let T = scale3(sub3(scale3(dPdx, dUy[1]), scale3(dPdy, dUx[1])), 1 / det);
  let B = scale3(sub3(scale3(dPdy, dUx[0]), scale3(dPdx, dUy[0])), 1 / det);
  T = normalize3(sub3(T, scale3(N, dot3(N, T))));
  B = normalize3(sub3(sub3(B, scale3(N, dot3(N, B))), scale3(T, dot3(T, B))));

  const rdView = scale3(V, -1);
  const rd = normalize3([dot3(rdView, T), dot3(rdView, B), -dot3(rdView, N)]);
  if (rd[2] < 1e-4) rd[2] = 1e-4;
  let tx = 1e9;
  let ty = 1e9;
  if (Math.abs(rd[0]) > 1e-5) tx = ((rd[0] > 0 ? 1 : -1) - f[0]) / rd[0];
  if (Math.abs(rd[1]) > 1e-5) ty = ((rd[1] > 0 ? 1 : -1) - f[1]) / rd[1];
  const t = Math.min(tx, ty);
  const wallX = tx < ty;
  const z = Math.min(rd[2] * t, 40);

  const fr = fract(z / 0.2);
  const bar = 1 - smoothstep(0, 0.8, fr) * smoothstep(0, 0.8, 1 - fr);
  const fade = Math.exp(-z * 0.98);
  const shade = wallX ? (rd[0] > 0 ? 1 : 0.85) : (rd[1] > 0 ? 0.92 : 0.78);
  const col = hsv2rgb(clamp(z * 0.12, 0, 1) - ctx.time * 0.05, 1, 1);
  return col.map((c) => clamp(
    c * bar * shade * fade
      + c * Math.pow(bar, 4) * fade * 0.5
      + c * fade * 0.06
      + Math.pow(bar, 10) * fade * 0.15,
    0,
    1,
  )).concat(1);
}

// `speed` is how many seconds of shader time one second of the clip covers.
// A GIF is a second or two long and several of these move over tens of
// seconds (the end portal scrolls 1% of its texture a second), so at real
// speed the clip would show nothing moving.
// `filter: "nearest"` is for pixel art, which linear filtering would smear.
export const SHADER_CLOAKS = new Map(Object.entries({
  "cosmetics/cloaks/testerplus_shader_rainbow.webp": {
    fragment: testerplusRainbow, outSize: [176, 136], samplers: {}, speed: 2,
  },
  "cosmetics/cloaks/lunarplus_glow/lunarplus_glow.webp": {
    fragment: lunarplusGlow, outSize: [660, 510], speed: 1,
    samplers: { LunarLogo: { resource: "lunar-jit:cosmetics/cloaks/lunarplus_glow/lunar_logo.webp" } },
  },
  "cosmetics/cloaks/staff_dev/staff_dev.webp": {
    fragment: staffDev, outSize: [814, 629], speed: 4,
    samplers: { LunarLogo: { resource: "lunar-jit:cosmetics/cloaks/staff_dev/lunar_dev.webp" } },
  },
  "cosmetics/cloaks/staff_holographic/staff_holographic.webp": {
    fragment: staffHolographic, outSize: [814, 629], speed: 4,
    samplers: { LunarLogo: { resource: "lunar-jit:cosmetics/cloaks/lunarplus_glow/lunar_logo.webp" } },
  },
  "cosmetics/cloaks/ingame_debug/normal_debug.webp": {
    fragment: normalDebug, outSize: [176, 136], samplers: {}, speed: 1,
  },
  "cosmetics/cloaks/ingame_debug/position_debug.webp": {
    fragment: positionDebug, outSize: [176, 136], samplers: {}, speed: 1,
  },
  "cosmetics/cloaks/dev_end_portal/dev_end_portal.webp": {
    fragment: devEndPortal, outSize: [1716, 1326], speed: 20,
    samplers: {
      EndPortal: { resource: "lunar-jit:cosmetics/cloaks/dev_end_portal/end.webp" },
      LunarLogo: { resource: "lunar-jit:cosmetics/cloaks/dev_end_portal/lunar.webp" },
    },
  },
  "cosmetics/cloaks/endportal_bw/endportal_bw.webp": {
    fragment: endPortalBw, outSize: [1716, 1326], speed: 20,
    samplers: { EndPortal: { resource: "lunar-jit:cosmetics/cloaks/endportal_bw/end.webp" } },
  },
  "cosmetics/cloaks/ingame_debug/screen_debug.webp": {
    fragment: screenDebug, outSize: [176, 136], samplers: {}, speed: 1,
  },
  "cosmetics/cloaks/staff_infinity/staff_infinity.webp": {
    fragment: staffInfinity, outSize: [660, 510], samplers: {}, speed: 6,
  },
  "cosmetics/cloaks/leaves/leaves.webp": {
    fragment: leaves, outSize: [176, 136], speed: 1,
    samplers: { Leaves: { resource: "lunar-jit:cosmetics/cloaks/leaves/leaves_gray.webp", filter: "nearest" } },
  },
}));

/**
 * The shader port for a catalogue resource, or null.
 *
 * @param resource the cosmetic's `resource`, e.g. "lunar:cosmetics/cloaks/x.webp"
 * @returns the port entry, or null when the cloak is not a shader cloak
 */
export function shaderCloakFor(resource) {
  if (typeof resource !== "string") return null;
  return SHADER_CLOAKS.get(resource.replace(/^lunar(?:-jit)?:/, "")) ?? null;
}

const UNIFORM_DEFAULTS = {
  velocity: 0,
  // Plains foliage, the colour a Minecraft biome map gives most open ground.
  biomeColor: [0x77 / 255, 0xab / 255, 0x2f / 255],
  lunarPlusColor: [0x3d / 255, 0x9b / 255, 0xff / 255],
};

// Written without per-texel arrays: the end portal samples 15 times a pixel,
// and allocating there tripled its render time.
function sampleTexture(texture, filter, u, v) {
  const { width, height, data } = texture;
  const index = (x, y) => (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
  if (filter === "nearest") {
    const i = index(Math.floor(u * width), Math.floor(v * height));
    return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, data[i + 3] / 255];
  }
  const x = u * width - 0.5;
  const y = v * height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = index(x0, y0);
  const b = index(x0 + 1, y0);
  const c = index(x0, y0 + 1);
  const d = index(x0 + 1, y0 + 1);
  const out = [0, 0, 0, 0];
  for (let k = 0; k < 4; k += 1) {
    const top = data[a + k] + (data[b + k] - data[a + k]) * fx;
    const bottom = data[c + k] + (data[d + k] - data[c + k]) * fx;
    out[k] = (top + (bottom - top) * fy) / 255;
  }
  return out;
}

/**
 * Binds a port to its decoded samplers, ready for the rasterizer.
 *
 * @param port a SHADER_CLOAKS entry
 * @param textures `{ [samplerName]: decodedTexture }`
 * @returns `(pixel, time) => [r, g, b, a]` with channels 0..1
 */
export function bindShader(port, textures) {
  const sample = (name, u, v) => {
    const texture = textures[name];
    if (!texture) return [0, 0, 0, 0];
    return sampleTexture(texture, port.samplers?.[name]?.filter, u, v);
  };
  return (pixel, time) => port.fragment({
    ...UNIFORM_DEFAULTS,
    ...pixel,
    time: time * (port.speed ?? 1),
    outSize: port.outSize,
    sample,
  });
}
