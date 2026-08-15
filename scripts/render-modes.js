import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { processSkin, resolveSkinSource } from "../src/minecraft.js";
import { renderFace, renderSkin } from "../src/renderer.js";

const requestedPlayer = process.argv[2] || "Oberaudorf";
const { skin, profile } = await resolveSkinSource(requestedPlayer);
const prefix = profile.name.replaceAll(/[^A-Za-z0-9_-]/g, "_");
const outputDirectory = resolve("examples", "modes");
await mkdir(outputDirectory, { recursive: true });

const common = {
  pose: "standing",
  slim: profile.slim,
  background: "e7e9ed",
  layerStyle: "voxel",
  layerDepth: 1,
  overlay: true,
  shadow: true,
  dropShadow: false,
  antialias: 2,
};

const renders = [
  ["fullbody", () => renderSkin(skin, { ...common, pose: "showcase", width: 399, height: 465 })],
  ["bust", () => renderSkin(skin, { ...common, mode: "bust", size: 512 })],
  ["frontfull", () => renderSkin(skin, {
    ...common,
    width: 256,
    height: 512,
    yaw: 0,
    pitch: 0,
    shading: false,
    shadow: false,
    layerStyle: "flat",
  })],
  ["fullbodyiso", () => renderSkin(skin, { ...common, size: 512, isometric: true })],
  ["head", () => renderSkin(skin, {
    ...common,
    mode: "head",
    size: 512,
    yaw: -25,
    pitch: 15,
    perspective: true,
    cameraDistance: 19,
    cameraTarget: [0, 28, 0],
    fov: 45,
    antialias: 4,
    layerStyle: "flat",
  })],
  ["face", () => renderFace(skin, { ...common, size: 512 })],
  ["headiso", () => renderSkin(skin, {
    ...common,
    mode: "head",
    size: 512,
    isometric: true,
    layerStyle: "flat",
  })],
  ["skin", () => processSkin(skin)],
];

for (const [mode, render] of renders) {
  const output = render();
  const filename = `${prefix}-${mode}.png`;
  await writeFile(resolve(outputDirectory, filename), output);
  console.log(`${filename}: ${output.length} bytes`);
}
