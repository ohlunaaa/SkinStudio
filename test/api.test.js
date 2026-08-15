import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import sharp from "sharp";
import { prepareCosmetics } from "../src/cosmetics.js";
import { createServer } from "../src/server.js";
import { renderFace, renderSkin } from "../src/renderer.js";

function sampleSkin() {
  const png = new PNG({ width: 64, height: 64 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (y * png.width + x) * 4;
      png.data[index] = (x * 4) % 256;
      png.data[index + 1] = (y * 4) % 256;
      png.data[index + 2] = 180;
      png.data[index + 3] = y < 32 ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function legacySkin() {
  const modern = PNG.sync.read(sampleSkin());
  const legacy = new PNG({ width: 64, height: 32 });
  modern.data.copy(legacy.data, 0, 0, legacy.data.length);
  return PNG.sync.write(legacy);
}

function opaqueSkin() {
  const png = new PNG({ width: 64, height: 64 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 70;
    png.data[index + 1] = 130;
    png.data[index + 2] = 210;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

function warmWhiteSkin() {
  const png = new PNG({ width: 64, height: 64 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 255;
    png.data[index + 1] = 248;
    png.data[index + 2] = 245;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

function skinWithTransparentHatFace() {
  const png = PNG.sync.read(opaqueSkin());
  for (let y = 0; y < 16; y += 1) {
    for (let x = 32; x < 64; x += 1) {
      png.data[(y * png.width + x) * 4 + 3] = 0;
    }
  }
  return PNG.sync.write(png);
}

function skinWithColoredLegCaps() {
  const png = PNG.sync.read(opaqueSkin());
  for (const [startX, startY] of [[4, 16], [20, 48]]) {
    for (let y = startY; y < startY + 4; y += 1) {
      for (let x = startX; x < startX + 4; x += 1) {
        const index = (y * png.width + x) * 4;
        png.data[index] = 0;
        png.data[index + 1] = 255;
        png.data[index + 2] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

function visibleComponents(image) {
  const seen = new Uint8Array(image.width * image.height);
  let components = 0;
  for (let start = 0; start < seen.length; start += 1) {
    if (seen[start] || image.data[start * 4 + 3] < 128) continue;
    components += 1;
    const pending = [start];
    seen[start] = 1;
    while (pending.length) {
      const pixel = pending.pop();
      const x = pixel % image.width;
      const y = Math.floor(pixel / image.width);
      for (const [nextX, nextY] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nextX < 0 || nextY < 0 || nextX >= image.width || nextY >= image.height) continue;
        const next = nextY * image.width + nextX;
        if (!seen[next] && image.data[next * 4 + 3] >= 128) {
          seen[next] = 1;
          pending.push(next);
        }
      }
    }
  }
  return components;
}

let server;
let baseUrl;
let lunarRootDirectory;

before(async () => {
  sharp.cache(false);
  lunarRootDirectory = await mkdtemp(join(tmpdir(), "skin-api-lunar-"));
  const manifestDirectory = join(lunarRootDirectory, "textures", "assets", "lunar");
  const textureDirectory = join(
    lunarRootDirectory,
    "jit",
    "assets",
    "lunar-jit",
    "cosmetics",
    "cloaks",
  );
  const mixedWingDirectory = join(
    lunarRootDirectory,
    "jit",
    "assets",
    "lunar-jit",
    "cosmetics",
    "models",
    "gek",
    "wings",
    "mixed_test",
  );
  const emoteModelDirectory = join(manifestDirectory, "emotes", "models");
  const emoteEntityDirectory = join(emoteModelDirectory, "entity");
  const emoteTextureDirectory = join(manifestDirectory, "emotes", "textures");
  await Promise.all([
    mkdir(manifestDirectory, { recursive: true }),
    mkdir(textureDirectory, { recursive: true }),
    mkdir(mixedWingDirectory, { recursive: true }),
    mkdir(emoteModelDirectory, { recursive: true }),
    mkdir(emoteEntityDirectory, { recursive: true }),
    mkdir(emoteTextureDirectory, { recursive: true }),
  ]);
  await writeFile(join(manifestDirectory, "cosmetics.json"), JSON.stringify([
    {
      id: 101,
      name: "Test Cloak",
      resource: "lunar:cosmetics/cloaks/test.webp",
      category: "cloak",
      indexType: "NONE",
      geckolibCosmetic: false,
      animated: false,
    },
    {
      id: 102,
      name: "Mixed Test Wings",
      resource: "lunar:cosmetics/models/gek/wings/mixed_test/mixed_test.gek.json",
      category: "dragon_wings",
      indexType: "NONE",
      geckolibCosmetic: true,
      animated: true,
    },
    {
      id: 103,
      name: "Off-by-one Animated Cloak",
      resource: "lunar:cosmetics/cloaks/off-by-one.webp",
      category: "cloak",
      indexType: "NONE",
      geckolibCosmetic: false,
      animated: true,
    },
  ]));
  await writeFile(join(manifestDirectory, "emotes", "emotes.json"), JSON.stringify({
    actions: ["lunar:emotes/models/actions.bobj"],
    emotes: [
      {
        id: 900,
        name: "test_dance",
        author: "Test",
        duration: 10,
        looping: true,
      },
      {
        id: 901,
        name: "test_prop",
        author: "Test",
        duration: 46,
        looping: false,
        meshes: [{ name: "test_prop_mesh", show_at: 1 }],
      },
    ],
    props: ["lunar:emotes/models/props.bobj"],
    meshes: {
      test_prop_mesh: {
        texture: "lunar:emotes/textures/test-prop.webp",
        normals: true,
        visible: false,
      },
    },
  }));
  await writeFile(join(emoteModelDirectory, "actions.bobj"), [
    "# Animation data",
    "an emote_test_dance",
    "ao anchor",
    "ag location 1",
    "kf 0 0 LINEAR 0 0 0 0",
    "kf 10 0.125 LINEAR 10 0.125 10 0.125",
    "ao right_arm",
    "ag rotation 0",
    "kf 0 0 BEZIER 0 0 2 0",
    "kf 5 3.141593 BEZIER 3 3.141593 7 3.141593",
    "kf 10 0 BEZIER 8 0 10 0",
    "ao left_leg",
    "ag rotation 0",
    "kf 0 0 LINEAR 0 0 0 0",
    "kf 10 0.5 LINEAR 10 0.5 10 0.5",
    "an emote_test_prop",
    "ao misc_gbone_1",
    "ag scale 0",
    "kf 0 0 LINEAR 0 0 0 0",
    "kf 6 1 LINEAR 6 1 6 1",
    "kf 38 1 LINEAR 38 1 38 1",
    "kf 46 0 LINEAR 46 0 46 0",
    "ag scale 1",
    "kf 0 0 LINEAR 0 0 0 0",
    "kf 6 1 LINEAR 6 1 6 1",
    "kf 38 1 LINEAR 38 1 38 1",
    "kf 46 0 LINEAR 46 0 46 0",
    "ag scale 2",
    "kf 0 0 LINEAR 0 0 0 0",
    "kf 6 1 LINEAR 6 1 6 1",
    "kf 38 1 LINEAR 38 1 38 1",
    "kf 46 0 LINEAR 46 0 46 0",
    "",
  ].join("\n"));
  await writeFile(join(emoteModelDirectory, "props.bobj"), [
    "o test_prop_mesh",
    "o_arm Armature",
    "v -0.25 1.25 0.5",
    "vw misc_gbone_1 1",
    "v -0.25 0.75 0.5",
    "vw misc_gbone_1 1",
    "v 0.25 1.25 0.5",
    "vw misc_gbone_1 1",
    "v 0.25 0.75 0.5",
    "vw misc_gbone_1 1",
    "vt 0 1",
    "vt 0 0",
    "vt 1 1",
    "vt 1 0",
    "vn 0 0 1",
    "f 1/1/1 2/2/1 3/3/1",
    "f 3/3/1 2/2/1 4/4/1",
    "",
  ].join("\n"));
  const bind = (name, parent, x, y, z) => [
    "arm_bone",
    name,
    parent,
    x / 16,
    (y - 6) / 16,
    z / 16,
    1, 0, 0, x / 16,
    0, 1, 0, y / 16,
    0, 0, 1, z / 16,
    0, 0, 0, 1,
  ].join(" ");
  await writeFile(join(emoteEntityDirectory, "default.bobj"), [
    "arm_name Armature",
    bind("anchor", "", 0, 0, 0),
    bind("body", "anchor", 0, 12, 0),
    bind("low_body", "body", 0, 18, 0),
    bind("head", "low_body", 0, 24, 0),
    bind("right_arm", "low_body", -6, 22, 0),
    bind("low_right_arm", "right_arm", -6, 18, 0),
    bind("left_arm", "low_body", 6, 22, 0),
    bind("low_left_arm", "left_arm", 6, 18, 0),
    bind("right_leg", "body", -2, 12, 0),
    bind("low_leg_right", "right_leg", -2, 6, 0),
    bind("left_leg", "body", 2, 12, 0),
    bind("low_left_leg", "left_leg", 2, 6, 0),
    bind("misc_gbone_1", "", 0, 0, 0),
    "",
  ].join("\n"));
  await Promise.all([
    sharp({
      create: { width: 22, height: 17, channels: 4, background: "#e11d48" },
    }).webp({ lossless: true }).toFile(join(textureDirectory, "test.webp")),
    sharp({
      create: { width: 3, height: 8, channels: 4, background: "#7c3aed" },
    }).webp({ lossless: true }).toFile(join(textureDirectory, "off-by-one.webp")),
    writeFile(
      join(textureDirectory, "off-by-one.webp.mcmeta"),
      JSON.stringify({ animation: { width: 4, height: 4, frametime: 1 } }),
    ),
    sharp({
      create: { width: 2, height: 1, channels: 4, background: "#38bdf8" },
    }).webp({ lossless: true }).toFile(join(mixedWingDirectory, "mixed_test.webp")),
    sharp({
      create: { width: 4, height: 4, channels: 4, background: "#ff00ff" },
    }).webp({ lossless: true }).toFile(join(emoteTextureDirectory, "test-prop.webp")),
    writeFile(join(mixedWingDirectory, "mixed_test.gek.json"), JSON.stringify({
      type: "pet",
      attached_bone: "SHOULDER",
      model: "lunar:cosmetics/models/gek/wings/mixed_test/mixed_test.geo.json",
      texture: "lunar:cosmetics/models/gek/wings/mixed_test/mixed_test.webp",
      animation: "lunar:cosmetics/models/gek/wings/mixed_test/mixed_test.anim.json",
      cosmetic_options: [{
        type: "float",
        id: "Size",
        molang_query: "option.size",
        default: 3,
      }],
      state_machine: {
        controllers: [{ states: [{ anim: "walk", plays_when: "1" }] }],
      },
    })),
    writeFile(join(mixedWingDirectory, "mixed_test.geo.json"), JSON.stringify({
      "minecraft:geometry": [{
        description: { texture_width: 2, texture_height: 1 },
        bones: [
          {
            name: "root",
            cubes: [{ origin: [-0.5, 0, -0.5], size: [1, 1, 1], uv: [0, 0] }],
          },
          {
            name: "wing",
            parent: "root",
            pivot: [0, 0, 0],
            cubes: [
              {
                origin: [0, 0, 0],
                size: [2, 2, 0],
                uv: {
                  north: { uv: [0, 0], uv_size: [1, 1] },
                  south: { uv: [1, 0], uv_size: [1, 1] },
                },
              },
              {
                origin: [2, 0, 0],
                size: [2, 2, 0],
                uv: {
                  north: { uv: [0, 0], uv_size: [1, 1] },
                  south: { uv: [1, 0], uv_size: [1, 1] },
                },
              },
            ],
          },
        ],
      }],
    })),
    writeFile(join(mixedWingDirectory, "mixed_test.anim.json"), JSON.stringify({
      animations: {
        walk: {
          bones: {
            root: {
              scale: [
                "option.size == 3 ? 0.6 : 0",
                "option.size >= 3 && option.size < 4 ? 0.6 : 0",
                "option.size != 3 || option.size > 4 ? 0 : 0.6",
              ],
            },
            wing: { rotation: [0, 90, 0] },
          },
        },
      },
    })),
  ]);
  process.env.LUNAR_CLIENT_DIR = lunarRootDirectory;
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.LUNAR_CLIENT_DIR;
  await rm(lunarRootDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

test("renderer creates a full-size RGBA PNG", () => {
  const result = renderSkin(sampleSkin(), { size: 128, pose: "standing", antialias: 1 });
  const image = PNG.sync.read(result);
  assert.equal(image.width, 128);
  assert.equal(image.height, 128);
  let visiblePixels = 0;
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] > 0) visiblePixels += 1;
  }
  assert.ok(visiblePixels > 1000);
});

test("bright shading clamps highlights instead of wrapping them into cyan", () => {
  const image = PNG.sync.read(renderSkin(warmWhiteSkin(), {
    size: 128,
    pose: "standing",
    antialias: 1,
    shading: true,
    shadow: false,
  }));
  let wrappedHighlights = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index] < 32 && image.data[index + 1] > 200 && image.data[index + 2] > 200) {
      wrappedHighlights += 1;
    }
  }
  assert.equal(wrappedHighlights, 0);
});

test("face renderer maps the front head pixels without smoothing", () => {
  const result = PNG.sync.read(renderFace(sampleSkin(), {
    size: 80,
    overlay: false,
  }));
  const index = (5 * result.width + 5) * 4;
  assert.deepEqual([...result.data.subarray(index, index + 4)], [32, 32, 180, 255]);
});

test("face renderer keeps the clean expanded hat-layer border", () => {
  const result = PNG.sync.read(renderFace(skinWithTransparentHatFace(), {
    size: 96,
    antialias: 2,
  }));
  assert.equal(result.data[3], 0);
  const center = ((48 * result.width) + 48) * 4;
  assert.equal(result.data[center + 3], 255);
});

test("different poses produce different renders", () => {
  const skin = sampleSkin();
  const walking = renderSkin(skin, { size: 96, pose: "walking", antialias: 1 });
  const cheering = renderSkin(skin, { size: 96, pose: "cheering", antialias: 1 });
  assert.notDeepEqual(walking, cheering);
});

test("waving visibly moves while the raised arm stays connected", () => {
  const options = {
    size: 128,
    pose: "waving",
    overlay: false,
    shadow: false,
    dropShadow: false,
    isometric: false,
    perspective: false,
    yaw: 0,
    pitch: 0,
    antialias: 1,
    stableFraming: true,
  };
  const left = PNG.sync.read(renderSkin(opaqueSkin(), { ...options, frame: 0.25 }));
  const right = PNG.sync.read(renderSkin(opaqueSkin(), { ...options, frame: 0.75 }));
  assert.notDeepEqual(left.data, right.data);
  assert.equal(visibleComponents(left), 1);
  assert.equal(visibleComponents(right), 1);
});

test("mixed 3D dragon wings keep planar panels assembled and use their outward UV side", async () => {
  const [cosmetic] = await prepareCosmetics([102]);
  const wingTriangles = cosmetic.meshes
    .flatMap((mesh) => mesh.triangles)
    .filter((triangle) => triangle.renderOrder >= 1000);
  const front = wingTriangles.find((triangle) => triangle.faceName === "front");
  assert.ok(front);
  assert.ok(front.uvs.every(([u]) => u < 1));
  assert.ok(wingTriangles.every((triangle) => (
    triangle.points.every(([, , z]) => Math.abs(z) < 0.001)
  )));
  assert.ok(Math.max(...wingTriangles.flatMap((triangle) => (
    triangle.points.map(([x]) => x)
  ))) < 2.401);
});

test("animated cloak frame metadata is clamped to a one-pixel-narrow source atlas", async () => {
  const [cosmetic] = await prepareCosmetics([103]);
  assert.equal(cosmetic.texture.width, 3);
  assert.equal(cosmetic.texture.height, 4);
  assert.ok(cosmetic.meshes.flatMap((mesh) => mesh.triangles).length > 0);
});

test("cloak, dragon wings, and pets move with the cosmetic animation phase", async () => {
  const [cloak] = await prepareCosmetics([101]);
  const wingTexture = new PNG({ width: 1, height: 1 });
  wingTexture.data.set([56, 189, 248, 255]);
  const wingTriangle = (points) => ({
    points,
    uvs: [[0, 0], [0, 0], [0, 0]],
    faceCoords: [[0, 0], [1, 0], [1, 1]],
    attachment: "body",
  });
  const visibleWings = {
    id: 104,
    category: "dragon_wings",
    texture: wingTexture,
    meshes: [{
      attachment: "body",
      triangles: [
        wingTriangle([[-1, 28, -3], [-1, 14, -3], [-14, 12, -4]]),
        wingTriangle([[-1, 28, -3], [-14, 12, -4], [-14, 27, -4]]),
        wingTriangle([[1, 28, -3], [14, 12, -4], [1, 14, -3]]),
        wingTriangle([[1, 28, -3], [14, 27, -4], [14, 12, -4]]),
      ],
    }],
  };
  const visiblePet = {
    id: 105,
    category: "pet",
    texture: wingTexture,
    meshes: [{
      attachment: "body",
      triangles: [
        wingTriangle([[-13, 28, -2], [-13, 20, -2], [-6, 20, -2]]),
        wingTriangle([[-13, 28, -2], [-6, 20, -2], [-6, 28, -2]]),
      ],
    }],
  };
  const options = {
    size: 128,
    pose: "standing",
    overlay: false,
    shadow: false,
    dropShadow: false,
    isometric: false,
    perspective: false,
    yaw: 180,
    pitch: 8,
    antialias: 1,
    stableFraming: true,
    animateCosmetics: true,
  };
  for (const cosmetic of [cloak, visibleWings, visiblePet]) {
    const start = renderSkin(opaqueSkin(), { ...options, cosmetics: [cosmetic], frame: 0.25 });
    const moving = renderSkin(opaqueSkin(), { ...options, cosmetics: [cosmetic], frame: 0.75 });
    assert.notDeepEqual(start, moving, `${cosmetic.category} must move between animation phases`);
  }
});

test("full-coverage cosmetics hide the underlying skin parts", () => {
  const options = {
    size: 128,
    pose: "standing",
    overlay: false,
    shadow: false,
    dropShadow: false,
    isometric: false,
    perspective: false,
    stableFraming: true,
    yaw: 0,
    pitch: 0,
    antialias: 1,
  };
  const full = PNG.sync.read(renderSkin(opaqueSkin(), options));
  const hidden = PNG.sync.read(renderSkin(opaqueSkin(), {
    ...options,
    cosmetics: [{ hiddenParts: ["rightArm"], meshes: [] }],
  }));
  const visiblePixels = (image) => {
    let count = 0;
    for (let index = 3; index < image.data.length; index += 4) {
      if (image.data[index] > 0) count += 1;
    }
    return count;
  };
  assert.ok(visiblePixels(hidden) < visiblePixels(full));
});

test("cosmetics render above the voxelized second skin layer", () => {
  const texture = new PNG({ width: 1, height: 1 });
  texture.data.set([255, 0, 0, 255]);
  const properties = {
    uvs: [[0, 0], [0, 0], [0, 0]],
    faceCoords: [[0, 0], [1, 0], [1, 1]],
  };
  const cosmetics = [{
    id: 999,
    category: "bandanna",
    texture,
    meshes: [{
      attachment: "head",
      triangles: [
        { ...properties, points: [[-3, 26, 4.5], [3, 26, 4.5], [3, 30, 4.5]] },
        { ...properties, points: [[-3, 26, 4.5], [3, 30, 4.5], [-3, 30, 4.5]] },
      ],
    }],
  }];
  const image = PNG.sync.read(renderSkin(opaqueSkin(), {
    cosmetics,
    size: 128,
    pose: "standing",
    shadow: false,
    dropShadow: false,
    isometric: false,
    perspective: false,
    stableFraming: true,
    yaw: 0,
    pitch: 0,
    antialias: 1,
  }));
  let redPixels = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index] > 180 && image.data[index + 1] < 40 && image.data[index + 2] < 40) {
      redPixels += 1;
    }
  }
  assert.ok(redPixels > 100);
});

test("raised arms stay visibly connected to the torso", () => {
  const result = renderSkin(opaqueSkin(), {
    size: 128,
    pose: "cheering",
    overlay: false,
    shadow: false,
    dropShadow: false,
    isometric: false,
    perspective: false,
    yaw: 0,
    pitch: 0,
    antialias: 1,
  });
  assert.equal(visibleComponents(PNG.sync.read(result)), 1);
});

test("pointing arm stays connected and below the head", () => {
  const result = renderSkin(opaqueSkin(), {
    size: 128,
    pose: "pointing",
    overlay: false,
    shadow: false,
    dropShadow: false,
    antialias: 1,
  });
  assert.equal(visibleComponents(PNG.sync.read(result)), 1);
});

test("sitting hides normally covered leg-cap colors", () => {
  const result = PNG.sync.read(renderSkin(skinWithColoredLegCaps(), {
    size: 128,
    pose: "sitting",
    overlay: false,
    shadow: false,
    dropShadow: false,
    antialias: 1,
  }));
  let cyanPixels = 0;
  for (let index = 0; index < result.data.length; index += 4) {
    if (result.data[index] < 20 && result.data[index + 1] > 180 && result.data[index + 2] > 180) {
      cyanPixels += 1;
    }
  }
  assert.equal(cyanPixels, 0);
});

test("showcase projection is default and true isometric remains available", () => {
  const skin = sampleSkin();
  const automatic = renderSkin(skin, { size: 96, pose: "standing", antialias: 1, shadow: false });
  const showcase = renderSkin(skin, {
    size: 96,
    pose: "standing",
    antialias: 1,
    shadow: false,
    isometric: false,
    perspective: false,
    yaw: -10,
    pitch: 12,
  });
  const isometric = renderSkin(skin, {
    size: 96,
    pose: "standing",
    antialias: 1,
    shadow: false,
    isometric: true,
  });
  assert.deepEqual(automatic, showcase);
  assert.notDeepEqual(automatic, isometric);
});

test("pose endpoint lists the supported types", async () => {
  const response = await fetch(`${baseUrl}/v1/poses`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(body.poses.some((pose) => pose.name === "crouching"));
});

test("Lunar emote catalog exposes ids and animation metadata", async () => {
  const listResponse = await fetch(`${baseUrl}/v1/emotes?q=dance`);
  const list = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(list.emotes.length, 1);
  assert.equal(list.emotes[0].id, 900);
  assert.equal(list.emotes[0].looping, true);

  const itemResponse = await fetch(`${baseUrl}/v1/emotes/test_dance`);
  const item = await itemResponse.json();
  assert.equal(itemResponse.status, 200);
  assert.equal(item.emote.duration, 10);
});

test("cosmetic catalog exposes Lunar ids and local availability", async () => {
  const response = await fetch(`${baseUrl}/v1/cosmetics/101`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.cosmetic.id, 101);
  assert.equal(body.cosmetic.name, "Test Cloak");
  assert.equal(body.cosmetic.available, true);
});

test("full-body upload renders a Lunar cosmetic selected by id", async () => {
  const response = await fetch(`${baseUrl}/v1/render?cosmetic=101&size=96&antialias=1`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: sampleSkin(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lunar-cosmetics"), "101");
  assert.equal(PNG.sync.read(Buffer.from(await response.arrayBuffer())).width, 96);
});

test("full-body render accepts mixed repeated and comma-separated cosmetic ids", async () => {
  const response = await fetch(
    `${baseUrl}/v1/render?cosmetic=101,102&cosmetics=102&cosmetic=103,101&size=96&antialias=1`,
    {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: sampleSkin(),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-lunar-cosmetics"), "101,102,103");
  assert.equal(PNG.sync.read(Buffer.from(await response.arrayBuffer())).width, 96);
});

test("head modes reject full-body cosmetics", async () => {
  const response = await fetch(`${baseUrl}/head?cosmetic=101&size=96`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: sampleSkin(),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /only supported by full-body/);
});

test("upload endpoint renders a raw PNG body", async () => {
  const response = await fetch(`${baseUrl}/v1/render?type=marching&size=96&antialias=1`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: sampleSkin(),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const output = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  assert.equal(output.width, 96);
});

test("NMSR-compatible upload routes render every documented mode", async () => {
  for (const mode of [
    "fullbody",
    "fullbodyback",
    "bust",
    "frontfull",
    "fullbodyiso",
    "head",
    "face",
    "headiso",
  ]) {
    const response = await fetch(
      `${baseUrl}/${mode}?size=96&alex&noshading&nolayers&antialias=1`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: sampleSkin(),
      },
    );
    assert.equal(response.status, 200, mode);
    assert.equal(response.headers.get("content-type"), "image/png", mode);
    const output = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
    assert.equal(output.width, 96, mode);
    assert.equal(output.height, 96, mode);
  }
});

test("back view endpoint renders cosmetics from behind", async () => {
  const request = (path) => fetch(`${baseUrl}${path}?cosmetic=101&size=96&antialias=1`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: sampleSkin(),
  });
  const [frontResponse, backResponse] = await Promise.all([
    request("/fullbody"),
    request("/fullbodyback"),
  ]);
  const front = Buffer.from(await frontResponse.arrayBuffer());
  const back = Buffer.from(await backResponse.arrayBuffer());
  assert.equal(backResponse.status, 200);
  assert.equal(backResponse.headers.get("x-lunar-cosmetics"), "101");
  assert.notDeepEqual(front, back);
});

test("NMSR-compatible skin process upgrades a legacy skin", async () => {
  const response = await fetch(`${baseUrl}/skin?process`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: legacySkin(),
  });
  assert.equal(response.status, 200);
  const output = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  assert.equal(output.width, 64);
  assert.equal(output.height, 64);
});

test("upload endpoint can render an animated APNG", async () => {
  const response = await fetch(
    `${baseUrl}/v1/render?type=walking&animated=true&frames=3&fps=8&size=64&layers=none&antialias=1`,
    {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: sampleSkin(),
    },
  );
  const output = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/apng");
  assert.equal(output.subarray(1, 4).toString("ascii"), "PNG");
  assert.ok(output.includes(Buffer.from("acTL")));
  assert.ok(output.includes(Buffer.from("fdAT")));
});

test("upload endpoint can render a multi-frame animated GIF", async () => {
  const response = await fetch(
    `${baseUrl}/v1/render?pose=waving&format=gif&download=true&frames=4&fps=10&size=64&layers=none&antialias=1`,
    {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: sampleSkin(),
    },
  );
  const output = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(output, { animated: true }).metadata();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/gif");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="skin-waving.gif"');
  assert.equal(output.subarray(0, 3).toString("ascii"), "GIF");
  assert.equal(metadata.pages, 4);
  assert.equal(metadata.pageHeight, 64);
  assert.deepEqual(metadata.delay, [100, 100, 100, 100]);
});

test("upload endpoint renders native Lunar emote keyframes as a downloadable GIF", async () => {
  const response = await fetch(
    `${baseUrl}/v1/render?emote=900&format=gif&download=true&size=64&layers=none&antialias=1`,
    {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: sampleSkin(),
    },
  );
  const output = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(output, { animated: true }).metadata();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/gif");
  assert.equal(response.headers.get("x-lunar-emote"), "900:test_dance");
  assert.equal(response.headers.get("x-lunar-emote-duration"), "10");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="skin-test_dance.gif"');
  assert.equal(metadata.pages, 10);
  assert.deepEqual(metadata.delay, Array(10).fill(50));
});

test("Lunar emote props use their BOBJ bones, texture, visibility, and full native duration", async () => {
  const requestFrame = (frame) => fetch(
    `${baseUrl}/v1/render?emote=901&frame=${frame}&size=96&layers=none&antialias=1&noshading`,
    {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: sampleSkin(),
    },
  );
  const [hiddenResponse, visibleResponse] = await Promise.all([
    requestFrame(0),
    requestFrame(0.5),
  ]);
  const hidden = PNG.sync.read(Buffer.from(await hiddenResponse.arrayBuffer()));
  const visible = PNG.sync.read(Buffer.from(await visibleResponse.arrayBuffer()));
  const magentaPixels = (image) => {
    let count = 0;
    for (let index = 0; index < image.data.length; index += 4) {
      if (image.data[index] > 240 && image.data[index + 1] < 20 && image.data[index + 2] > 240) {
        count += 1;
      }
    }
    return count;
  };
  assert.equal(hiddenResponse.status, 200);
  assert.equal(visibleResponse.status, 200);
  assert.equal(magentaPixels(hidden), 0);
  assert.ok(magentaPixels(visible) > 10);

  const gifResponse = await fetch(
    `${baseUrl}/v1/render?emote=901&format=gif&size=64&layers=none&antialias=1&noshading`,
    {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: sampleSkin(),
    },
  );
  const metadata = await sharp(Buffer.from(await gifResponse.arrayBuffer()), { animated: true }).metadata();
  assert.equal(gifResponse.status, 200);
  assert.equal(metadata.pages, 46);
  assert.deepEqual(metadata.delay, Array(46).fill(50));
});

test("invalid poses return a useful 400 response", async () => {
  const response = await fetch(`${baseUrl}/v1/render?pose=flying`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: sampleSkin(),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unknown pose/);
});
