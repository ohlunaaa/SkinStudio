import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { downloadSkin, resolvePlayer } from "../src/minecraft.js";
import { renderSkin } from "../src/renderer.js";

const requestedPlayer = process.argv[2] || "Oberaudorf";
const profile = await resolvePlayer(requestedPlayer);
const skin = await downloadSkin(profile.textureUrl);
const filePrefix = profile.name.replaceAll(/[^A-Za-z0-9_-]/g, "_");
const outputDirectory = resolve("examples");
const poseDirectory = resolve(outputDirectory, "poses");
await mkdir(outputDirectory, { recursive: true });
await mkdir(poseDirectory, { recursive: true });

const common = {
  pose: "showcase",
  slim: profile.slim,
  background: "000000",
  layerStyle: "voxel",
  layerDepth: 1,
  isometric: false,
  perspective: false,
  yaw: -10,
  pitch: 12,
  padding: 0.1,
  shadow: true,
  dropShadow: false,
};

const renders = [
  { filename: `${filePrefix}-reference.png`, width: 399, height: 465 },
  { filename: `${filePrefix}-hd.png`, width: 880, height: 1024 },
];

for (const render of renders) {
  const outputPath = resolve(outputDirectory, render.filename);
  const png = renderSkin(skin, { ...common, width: render.width, height: render.height });
  await writeFile(outputPath, png);
  console.log(`${render.filename}: ${render.width}x${render.height} (${png.length} bytes)`);
}

for (const pose of ["walking", "marching", "running", "crouching", "cheering", "sitting", "waving", "pointing"]) {
  const outputPath = resolve(poseDirectory, `${filePrefix}-${pose}.png`);
  const png = renderSkin(skin, {
    ...common,
    pose,
    yaw: pose === "pointing" ? undefined : common.yaw,
    width: 399,
    height: 465,
    background: "e7e9ed",
  });
  await writeFile(outputPath, png);
  console.log(`poses/${filePrefix}-${pose}.png: 399x465 (${png.length} bytes)`);
}
