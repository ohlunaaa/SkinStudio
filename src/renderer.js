import { PNG } from "pngjs";
import { sampleEmotePose } from "./emotes.js";
import { getPose } from "./poses.js";

const EPSILON = 1e-7;
const TRUE_ISOMETRIC_YAW = -45;
const TRUE_ISOMETRIC_PITCH = 35.264389682754654;

const FACE_INDICES = {
  front: [3, 0, 1, 2],
  back: [6, 5, 4, 7],
  right: [7, 4, 0, 3],
  left: [2, 1, 5, 6],
  top: [7, 3, 2, 6],
  bottom: [0, 4, 5, 1],
};

const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      for (let k = 0; k < 4; k += 1) {
        out[row * 4 + col] += a[row * 4 + k] * b[k * 4 + col];
      }
    }
  }
  return out;
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function translation(x = 0, y = 0, z = 0) {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
}

function rotationX(angle = 0) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}

function rotationY(angle = 0) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}

function rotationZ(angle = 0) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function transformPoint(matrix, [x, y, z]) {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
    matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
    matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
  ];
}

function compose(...matrices) {
  return matrices.reduce((current, next) => multiply(current, next), identity());
}

function vectorSubtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(value) {
  const length = Math.hypot(...value) || 1;
  return value.map((component) => component / length);
}

function uvLayout(u, v, width, height, depth) {
  return {
    top: [u + depth, v, width, depth],
    bottom: [u + depth + width, v, width, depth],
    right: [u, v + depth, depth, height],
    front: [u + depth, v + depth, width, height],
    left: [u + depth + width, v + depth, depth, height],
    back: [u + depth * 2 + width, v + depth, width, height],
  };
}

function rectUvs(rect, textureScale) {
  const [x, y, width, height] = rect;
  const u0 = x * textureScale;
  const v0 = y * textureScale;
  const u1 = (x + width) * textureScale - EPSILON;
  const v1 = (y + height) * textureScale - EPSILON;
  return [
    [u0, v0],
    [u0, v1],
    [u1, v1],
    [u1, v0],
  ];
}

function createBox({ dimensions, matrix, uv, textureScale, layer = false, surfaceBase = 0, boxId = 0 }) {
  const [width, height, depth] = dimensions;
  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;
  const vertices = [
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
  ].map((point) => transformPoint(matrix, point));

  const triangles = [];
  let faceIndex = 0;
  for (const [faceName, indices] of Object.entries(FACE_INDICES)) {
    const faceUvs = rectUvs(uv[faceName], textureScale);
    const normal = normalize(cross(
      vectorSubtract(vertices[indices[1]], vertices[indices[0]]),
      vectorSubtract(vertices[indices[2]], vertices[indices[0]]),
    ));
    triangles.push({
      points: [vertices[indices[0]], vertices[indices[1]], vertices[indices[2]]],
      uvs: [faceUvs[0], faceUvs[1], faceUvs[2]],
      faceCoords: [[0, 0], [0, 1], [1, 1]],
      normal,
      layer,
      surfaceId: surfaceBase + faceIndex,
      boxId,
    });
    triangles.push({
      points: [vertices[indices[0]], vertices[indices[2]], vertices[indices[3]]],
      uvs: [faceUvs[0], faceUvs[2], faceUvs[3]],
      faceCoords: [[0, 0], [1, 1], [1, 0]],
      normal,
      layer,
      surfaceId: surfaceBase + faceIndex,
      boxId,
    });
    faceIndex += 1;
  }
  return triangles;
}

function interpolateQuad(corners, horizontal, vertical) {
  const top = corners[0].map((value, axis) => value * (1 - horizontal) + corners[3][axis] * horizontal);
  const bottom = corners[1].map((value, axis) => value * (1 - horizontal) + corners[2][axis] * horizontal);
  return top.map((value, axis) => value * (1 - vertical) + bottom[axis] * vertical);
}

function appendQuad(
  triangles,
  points,
  uvs,
  properties,
  faceCoords = [[0, 0], [0, 1], [1, 1], [1, 0]],
) {
  const normal = normalize(cross(
    vectorSubtract(points[1], points[0]),
    vectorSubtract(points[2], points[0]),
  ));
  triangles.push({
    points: [points[0], points[1], points[2]],
    uvs: [uvs[0], uvs[1], uvs[2]],
    faceCoords: [faceCoords[0], faceCoords[1], faceCoords[2]],
    normal,
    ...properties,
  });
  triangles.push({
    points: [points[0], points[2], points[3]],
    uvs: [uvs[0], uvs[2], uvs[3]],
    faceCoords: [faceCoords[0], faceCoords[2], faceCoords[3]],
    normal,
    ...properties,
  });
}

function overlayPixelVisible(texture, rect, column, row, textureScale) {
  const startX = Math.floor((rect[0] + column) * textureScale);
  const endX = Math.ceil((rect[0] + column + 1) * textureScale);
  const startY = Math.floor((rect[1] + row) * textureScale);
  const endY = Math.ceil((rect[1] + row + 1) * textureScale);
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      if (texture.data[(y * texture.width + x) * 4 + 3] > 8) return true;
    }
  }
  return false;
}

function localBoxVertices(dimensions) {
  const [width, height, depth] = dimensions;
  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;
  return [
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
  ];
}

function createVoxelLayer({
  dimensions,
  grow,
  matrix,
  uv,
  texture,
  textureScale,
  surfaceBase,
  boxId,
}) {
  const triangles = [];
  const innerVertices = localBoxVertices(dimensions);
  const outerVertices = localBoxVertices(dimensions.map((value) => value + grow));
  const properties = { layer: true, surfaceId: surfaceBase, boxId };

  for (const [faceName, indices] of Object.entries(FACE_INDICES)) {
    const rect = uv[faceName];
    const columns = rect[2];
    const rows = rect[3];
    const innerFace = indices.map((index) => innerVertices[index]);
    const outerFace = indices.map((index) => outerVertices[index]);
    const visible = Array.from({ length: rows }, (_, row) => (
      Array.from({ length: columns }, (_, column) => (
        overlayPixelVisible(texture, rect, column, row, textureScale)
      ))
    ));

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (!visible[row][column]) continue;
        const left = column / columns;
        const right = (column + 1) / columns;
        const top = row / rows;
        const bottom = (row + 1) / rows;
        const outer = [
          interpolateQuad(outerFace, left, top),
          interpolateQuad(outerFace, left, bottom),
          interpolateQuad(outerFace, right, bottom),
          interpolateQuad(outerFace, right, top),
        ];
        const inner = [
          interpolateQuad(innerFace, left, top),
          interpolateQuad(innerFace, left, bottom),
          interpolateQuad(innerFace, right, bottom),
          interpolateQuad(innerFace, right, top),
        ];
        const x0 = (rect[0] + column) * textureScale;
        const x1 = (rect[0] + column + 1) * textureScale - EPSILON;
        const y0 = (rect[1] + row) * textureScale;
        const y1 = (rect[1] + row + 1) * textureScale - EPSILON;
        const topUvs = [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
        const centerUv = [(x0 + x1) / 2, (y0 + y1) / 2];
        const sideUvs = [centerUv, centerUv, centerUv, centerUv];

        const topCoords = [[left, top], [left, bottom], [right, bottom], [right, top]];
        appendQuad(
          triangles,
          outer.map((point) => transformPoint(matrix, point)),
          topUvs,
          properties,
          topCoords,
        );
        if (row === 0 || !visible[row - 1][column]) {
          appendQuad(triangles, [inner[0], outer[0], outer[3], inner[3]].map((point) => transformPoint(matrix, point)), sideUvs, properties);
        }
        if (row === rows - 1 || !visible[row + 1][column]) {
          appendQuad(triangles, [outer[1], inner[1], inner[2], outer[2]].map((point) => transformPoint(matrix, point)), sideUvs, properties);
        }
        if (column === 0 || !visible[row][column - 1]) {
          appendQuad(triangles, [inner[1], outer[1], outer[0], inner[0]].map((point) => transformPoint(matrix, point)), sideUvs, properties);
        }
        if (column === columns - 1 || !visible[row][column + 1]) {
          appendQuad(triangles, [outer[3], outer[2], inner[2], inner[3]].map((point) => transformPoint(matrix, point)), sideUvs, properties);
        }
      }
    }
  }
  return triangles;
}

function partMatrix(parent, pivot, center, rotation = {}) {
  return compose(
    parent,
    translation(...pivot),
    rotationZ(rotation.z),
    rotationY(rotation.y),
    rotationX(rotation.x),
    translation(...center),
  );
}

function jointMatrix(parent, pivot, rotation = {}) {
  return compose(
    parent,
    translation(...pivot),
    rotationZ(rotation.z),
    rotationY(rotation.y),
    rotationX(rotation.x),
  );
}

function poseBodyMatrices(pose) {
  const rootOffset = pose.rootOffset || {};
  const rootRotation = pose.rootRotation || {};
  const upperOffset = pose.upperOffset || {};
  const upperRotation = pose.upperRotation || {};
  const world = compose(
    translation(rootOffset.x, rootOffset.y, rootOffset.z),
    translation(0, 12, 0),
    rotationZ(rootRotation.z),
    rotationY(rootRotation.y),
    rotationX(rootRotation.x),
    translation(0, -12, 0),
  );
  const upper = compose(
    world,
    translation(upperOffset.x, upperOffset.y, upperOffset.z),
    translation(0, 12, 0),
    rotationX(pose.upperLean),
    translation(0, -12, 0),
    translation(0, 18, 0),
    rotationZ(upperRotation.z),
    rotationY(upperRotation.y),
    rotationX(upperRotation.x),
    translation(0, -18, 0),
  );
  return { world, upper };
}

function frontBottomCap(layout) {
  const [x, y, width, height] = layout.front;
  const capHeight = Math.min(width, height);
  return {
    ...layout,
    bottom: [x, y + height - capHeight, width, capHeight],
  };
}

function frontTopCap(layout) {
  const [x, y, width, height] = layout.front;
  const capHeight = Math.min(width, height);
  return {
    ...layout,
    top: [x, y, width, capHeight],
  };
}

function poseLegUv(layout, pose) {
  let result = layout;
  if (pose.coverLegTops) result = frontTopCap(result);
  if (pose.frontSoles) result = frontBottomCap(result);
  return result;
}

function splitLimbUv(layout, lower, coverRootCap = false) {
  const split = 6;
  const result = { ...layout };
  for (const face of ["right", "front", "left", "back"]) {
    const [x, y, width, height] = layout[face];
    result[face] = lower
      ? [x, y + split, width, Math.max(1, height - split)]
      : [x, y, width, Math.min(split, height)];
  }
  const [frontX, frontY, frontWidth] = layout.front;
  const elbowCap = [frontX, frontY + split - 1, frontWidth, 1];
  if (lower) result.top = elbowCap;
  else {
    result.bottom = elbowCap;
    if (coverRootCap) result.top = [frontX, frontY, frontWidth, 1];
  }
  return result;
}

function makeGeometry({
  slim,
  texture,
  textureScale,
  overlay,
  layerStyle,
  layerDepth,
  legacy,
  pose,
  mode,
  hiddenParts = new Set(),
}) {
  const triangles = [];
  let surfaceBase = 0;
  let boxId = 0;
  const armWidth = slim ? 3 : 4;
  const includesPart = (name) => {
    if (hiddenParts.has(name)) return false;
    if (mode === "head") return name === "head";
    if (mode === "bust") return ["head", "body", "rightArm", "leftArm"].includes(name);
    return true;
  };
  const { world, upper } = poseBodyMatrices(pose);
  const emoteBones = pose.boneMatrices;

  const renderPart = ({ dimensions, matrix, baseUv, outerUv, outerGrow, hasOuterLayer }) => {
    triangles.push(...createBox({
      dimensions,
      matrix,
      uv: baseUv,
      textureScale,
      surfaceBase,
      boxId,
    }));
    surfaceBase += 6;

    if (overlay && hasOuterLayer) {
      const grow = outerGrow * layerDepth;
      if (layerStyle === "voxel") {
        triangles.push(...createVoxelLayer({
          dimensions,
          grow,
          matrix,
          uv: outerUv,
          texture,
          textureScale,
          surfaceBase,
          boxId,
        }));
        surfaceBase += 1;
      } else {
        triangles.push(...createBox({
          dimensions: dimensions.map((value) => value + grow),
          matrix,
          uv: outerUv,
          textureScale,
          layer: true,
          surfaceBase,
          boxId,
        }));
        surfaceBase += 6;
      }
    }
    boxId += 1;
  };

  const rigidParts = [
    {
      name: "head", dimensions: [8, 8, 8], pivot: [0, 24, 0], center: [0, 4, 0],
      parent: upper, baseUv: uvLayout(0, 0, 8, 8, 8), outerUv: uvLayout(32, 0, 8, 8, 8),
      outerGrow: 1, hasOuterLayer: true,
    },
    {
      name: "body", dimensions: [8, 12, 4], pivot: [0, 24, 0], center: [0, -6, 0],
      parent: upper, baseUv: uvLayout(16, 16, 8, 12, 4), outerUv: uvLayout(16, 32, 8, 12, 4),
      outerGrow: 0.5, hasOuterLayer: !legacy,
    },
  ];

  for (const part of rigidParts) {
    if (!includesPart(part.name)) continue;
    if (emoteBones && part.name === "body") {
      for (const lower of [true, false]) {
        const bone = lower ? emoteBones.body : emoteBones.low_body;
        const matrix = compose(bone || identity(), translation(0, lower ? 15 : 21, 0));
        renderPart({
          ...part,
          dimensions: [8, 6.2, 4],
          matrix,
          baseUv: splitLimbUv(part.baseUv, lower),
          outerUv: splitLimbUv(part.outerUv, lower),
        });
      }
      continue;
    }
    if (emoteBones && part.name === "head") {
      renderPart({
        ...part,
        matrix: compose(emoteBones.head || identity(), translation(0, 28, 0)),
      });
      continue;
    }
    const matrix = partMatrix(part.parent, part.pivot, part.center, pose[part.name]);
    renderPart({ ...part, matrix });
  }

  const limbs = [
    {
      name: "rightArm", dimensions: [armWidth, 12.2, 4],
      pivot: [-3.8, 23.8 - (pose.rightShoulderDrop ?? pose.shoulderDrop ?? 0), 0],
      centerX: -armWidth / 2,
      restCenterX: -4 - armWidth / 2,
      upperBone: "right_arm",
      lowerBone: "low_right_arm",
      lowerRotation: "rightForearm",
      parent: upper, baseUv: uvLayout(40, 16, armWidth, 12, 4), outerUv: uvLayout(40, 32, armWidth, 12, 4),
      outerGrow: 0.5, hasOuterLayer: !legacy,
    },
    {
      name: "leftArm", dimensions: [armWidth, 12.2, 4],
      pivot: [3.8, 23.8 - (pose.leftShoulderDrop ?? pose.shoulderDrop ?? 0), 0],
      centerX: armWidth / 2,
      restCenterX: 4 + armWidth / 2,
      upperBone: "left_arm",
      lowerBone: "low_left_arm",
      lowerRotation: "leftForearm",
      parent: upper,
      baseUv: legacy ? uvLayout(40, 16, armWidth, 12, 4) : uvLayout(32, 48, armWidth, 12, 4),
      outerUv: uvLayout(48, 48, armWidth, 12, 4), outerGrow: 0.5, hasOuterLayer: !legacy,
    },
    {
      name: "rightLeg", dimensions: [4, 12.2, 4], pivot: [-2, 12.2, 0],
      centerX: 0, centerY: -6 + (pose.legInset ?? 0),
      restCenterX: -2,
      upperBone: "right_leg",
      lowerBone: "low_leg_right",
      lowerRotation: "rightLowerLeg",
      parent: world,
      baseUv: poseLegUv(uvLayout(0, 16, 4, 12, 4), pose),
      outerUv: poseLegUv(uvLayout(0, 32, 4, 12, 4), pose),
      outerGrow: 0.5, hasOuterLayer: !legacy,
    },
    {
      name: "leftLeg", dimensions: [4, 12.2, 4], pivot: [2, 12.2, 0],
      centerX: 0, centerY: -6 + (pose.legInset ?? 0),
      restCenterX: 2,
      upperBone: "left_leg",
      lowerBone: "low_left_leg",
      lowerRotation: "leftLowerLeg",
      parent: world,
      baseUv: poseLegUv(legacy ? uvLayout(0, 16, 4, 12, 4) : uvLayout(16, 48, 4, 12, 4), pose),
      outerUv: poseLegUv(uvLayout(0, 48, 4, 12, 4), pose),
      outerGrow: 0.5, hasOuterLayer: !legacy,
    },
  ];

  for (const limb of limbs) {
    if (!includesPart(limb.name)) continue;
    if (emoteBones) {
      const segmentLength = 6.4;
      const upperMatrix = compose(
        emoteBones[limb.upperBone] || identity(),
        translation(limb.restCenterX, limb.name.endsWith("Arm") ? 21 : 9, 0),
      );
      const lowerMatrix = compose(
        emoteBones[limb.lowerBone] || identity(),
        translation(limb.restCenterX, limb.name.endsWith("Arm") ? 15 : 3, 0),
      );
      for (const [lower, matrix] of [[false, upperMatrix], [true, lowerMatrix]]) {
        renderPart({
          dimensions: [limb.dimensions[0], segmentLength, limb.dimensions[2]],
          matrix,
          baseUv: splitLimbUv(limb.baseUv, lower, true),
          outerUv: splitLimbUv(limb.outerUv, lower, true),
          outerGrow: limb.outerGrow,
          hasOuterLayer: limb.hasOuterLayer,
        });
      }
      continue;
    }
    const frame = jointMatrix(limb.parent, limb.pivot, pose[limb.name]);
    if (pose.articulated) {
      const jointDistance = 6;
      const segmentLength = 6.4;
      const upperMatrix = compose(
        frame,
        translation(limb.centerX, -jointDistance / 2, 0),
      );
      const lowerFrame = jointMatrix(
        frame,
        [limb.centerX, -jointDistance, 0],
        pose[limb.lowerRotation],
      );
      const lowerMatrix = compose(lowerFrame, translation(0, -jointDistance / 2, 0));
      renderPart({
        dimensions: [limb.dimensions[0], segmentLength, limb.dimensions[2]],
        matrix: upperMatrix,
        baseUv: splitLimbUv(limb.baseUv, false, true),
        outerUv: splitLimbUv(limb.outerUv, false, true),
        outerGrow: limb.outerGrow,
        hasOuterLayer: limb.hasOuterLayer,
      });
      renderPart({
        dimensions: [limb.dimensions[0], segmentLength, limb.dimensions[2]],
        matrix: lowerMatrix,
        baseUv: splitLimbUv(limb.baseUv, true, true),
        outerUv: splitLimbUv(limb.outerUv, true, true),
        outerGrow: limb.outerGrow,
        hasOuterLayer: limb.hasOuterLayer,
      });
      continue;
    }
    const matrix = compose(frame, translation(limb.centerX, limb.centerY ?? -6, 0));
    renderPart({
      dimensions: limb.dimensions,
      matrix,
      baseUv: limb.baseUv,
      outerUv: limb.outerUv,
      outerGrow: limb.outerGrow,
      hasOuterLayer: limb.hasOuterLayer,
    });
  }

  return triangles;
}

function cosmeticAttachmentMatrices(pose) {
  if (pose.boneMatrices) {
    const bones = pose.boneMatrices;
    return {
      world: bones.anchor || identity(),
      body: bones.low_body || bones.body || identity(),
      head: bones.head || identity(),
      rightArm: bones.right_arm || identity(),
      leftArm: bones.left_arm || identity(),
      rightLeg: bones.right_leg || identity(),
      leftLeg: bones.left_leg || identity(),
    };
  }
  const { world, upper } = poseBodyMatrices(pose);
  const attached = (parent, pivot, rotation) => compose(
    jointMatrix(parent, pivot, rotation),
    translation(-pivot[0], -pivot[1], -pivot[2]),
  );
  const rightShoulder = [-5, 22 - (pose.rightShoulderDrop ?? pose.shoulderDrop ?? 0), 0];
  const leftShoulder = [5, 22 - (pose.leftShoulderDrop ?? pose.shoulderDrop ?? 0), 0];
  const rightHip = [-1.9, 12, 0];
  const leftHip = [1.9, 12, 0];
  return {
    world,
    body: upper,
    head: attached(upper, [0, 24, 0], pose.head),
    rightArm: attached(upper, rightShoulder, pose.rightArm),
    leftArm: attached(upper, leftShoulder, pose.leftArm),
    rightLeg: attached(world, rightHip, pose.rightLeg),
    leftLeg: attached(world, leftHip, pose.leftLeg),
  };
}

function cosmeticMotionMatrix(cosmetic, point, frame, poseName, center = [0, 0, 0]) {
  const phase = ((Number(frame) || 0) % 1 + 1) % 1;
  const wave = Math.sin(phase * Math.PI * 2);
  const activity = ({ running: 1.6, marching: 1.3, walking: 1, waving: 0.8 })[poseName] || 0.55;

  if (cosmetic.category === "cloak") {
    const pivot = [0, 24, -2.5];
    // A raised waving arm should not make a cape oscillate from side to side.
    // Keep it resting behind the torso for that pose; locomotion poses retain
    // the stronger pendulum motion caused by walking and running.
    const waving = poseName === "waving";
    const backwardSwing = (waving ? 3 : ((5 * activity) + (4.5 * activity * wave)))
      * Math.PI / 180;
    const sideSwing = (waving ? 0 : (1.2 * activity * Math.sin(phase * Math.PI * 4)))
      * Math.PI / 180;
    return compose(
      translation(...pivot),
      rotationZ(sideSwing),
      rotationX(backwardSwing),
      translation(...pivot.map((value) => -value)),
    );
  }

  if (cosmetic.category === "dragon_wings") {
    const side = Math.sign(point[0]);
    if (!side || Math.abs(point[0]) < 0.35) return identity();
    const pivot = [side * 0.55, 19, -2.6];
    const depthFlap = side * wave * activity * 11 * Math.PI / 180;
    const liftFlap = side * wave * activity * 7 * Math.PI / 180;
    return compose(
      translation(...pivot),
      rotationZ(liftFlap),
      rotationY(depthFlap),
      translation(...pivot.map((value) => -value)),
    );
  }

  if (cosmetic.category === "pet") {
    const orbit = Math.cos(phase * Math.PI * 2);
    const figureEight = Math.sin(phase * Math.PI * 4);
    return compose(
      translation(orbit * 0.3, wave * 0.48, figureEight * 0.12),
      translation(...center),
      rotationZ(orbit * 2.5 * Math.PI / 180),
      rotationY(wave * 5 * Math.PI / 180),
      translation(...center.map((value) => -value)),
    );
  }

  if (cosmetic.category === "companion") {
    const orbit = Math.cos(phase * Math.PI * 2);
    return compose(
      translation(orbit * 0.16, wave * 0.28, 0),
      translation(...center),
      rotationY(wave * 2.5 * Math.PI / 180),
      translation(...center.map((value) => -value)),
    );
  }

  if (cosmetic.category === "auras") {
    return compose(
      translation(0, wave * 0.16 * activity, 0),
      translation(...center),
      rotationY(wave * 1.25 * activity * Math.PI / 180),
      translation(...center.map((value) => -value)),
    );
  }

  return identity();
}

function makeCosmeticGeometry(cosmetics, pose, options = {}) {
  if (!cosmetics?.length) return [];
  const matrices = cosmeticAttachmentMatrices(pose);
  const triangles = [];
  let surfaceId = 100_000;
  let boxId = 100_000;
  for (const cosmetic of cosmetics) {
    const behindBody = ["cloak", "dragon_wings"].includes(cosmetic.category);
    const depthBias = behindBody ? 0.05 : 0.75;
    for (const mesh of cosmetic.meshes || []) {
      const matrix = matrices[mesh.attachment] || matrices.body;
      const meshPoints = (mesh.triangles || []).flatMap((triangle) => triangle.points || []);
      const center = [0, 1, 2].map((axis) => {
        const values = meshPoints.map((point) => point[axis]);
        return values.length ? (Math.min(...values) + Math.max(...values)) / 2 : 0;
      });
      for (const triangle of mesh.triangles) {
        const points = triangle.points.map((point) => {
          const motion = options.animateCosmetics
            ? cosmeticMotionMatrix(cosmetic, point, options.frame, options.poseName, center)
            : identity();
          return transformPoint(matrix, transformPoint(motion, point));
        });
        triangles.push({
          ...triangle,
          points,
          normal: normalize(cross(
            vectorSubtract(points[1], points[0]),
            vectorSubtract(points[2], points[0]),
          )),
          texture: cosmetic.texture,
          cosmeticId: cosmetic.id,
          // Cosmetics are rendered after both skin layers. The small camera-
          // depth bias keeps face/body cosmetics above a voxelized second
          // layer without making cloaks or wings visible through the player.
          layer: 2,
          depthBias: depthBias + (triangle.renderOrder || 0) * 1e-7,
          surfaceId,
          boxId,
        });
        surfaceId += 1;
      }
      boxId += 1;
    }
  }
  return triangles;
}

function skinnedPropPoint(vertex, boneMatrices) {
  if (!vertex.weights?.length) return vertex.point;
  const point = [0, 0, 0];
  let totalWeight = 0;
  for (const { bone, weight } of vertex.weights) {
    const matrix = boneMatrices[bone];
    if (!matrix || !Number.isFinite(weight) || weight <= 0) continue;
    const transformed = transformPoint(matrix, vertex.point);
    point[0] += transformed[0] * weight;
    point[1] += transformed[1] * weight;
    point[2] += transformed[2] * weight;
    totalWeight += weight;
  }
  if (totalWeight <= EPSILON) return vertex.point;
  return totalWeight === 1 ? point : point.map((value) => value / totalWeight);
}

function makeEmotePropGeometry(pose) {
  if (!pose.emoteProps?.length || !pose.boneMatrices) return [];
  const triangles = [];
  let surfaceId = 200_000;
  let boxId = 200_000;
  for (const prop of pose.emoteProps) {
    if (pose.emoteTime + EPSILON < prop.showAt) continue;
    for (const face of prop.faces || []) {
      const points = face.map((vertex) => skinnedPropPoint(vertex, pose.boneMatrices));
      if (Math.hypot(...vectorSubtract(points[1], points[0])) <= EPSILON
        || Math.hypot(...vectorSubtract(points[2], points[0])) <= EPSILON) continue;
      triangles.push({
        points,
        uvs: face.map((vertex) => [
          vertex.uv[0] * prop.texture.width,
          (1 - vertex.uv[1]) * prop.texture.height,
        ]),
        faceCoords: face.map((vertex) => [vertex.uv[0], 1 - vertex.uv[1]]),
        normal: normalize(cross(
          vectorSubtract(points[1], points[0]),
          vectorSubtract(points[2], points[0]),
        )),
        texture: prop.texture,
        emoteProp: prop.name,
        layer: 2,
        depthBias: 0.08,
        surfaceId,
        boxId,
      });
      surfaceId += 1;
    }
    boxId += 1;
  }
  return triangles;
}

function projectGeometry(
  triangles,
  width,
  height,
  yawDegrees,
  pitchDegrees,
  padding,
  perspective,
  cameraDistance,
  stableFraming,
  target,
  fovDegrees,
) {
  const yaw = (yawDegrees * Math.PI) / 180;
  const pitch = (pitchDegrees * Math.PI) / 180;
  const distance = cameraDistance;
  const camera = [
    Math.sin(yaw) * Math.cos(pitch) * distance,
    target[1] + Math.sin(pitch) * distance,
    Math.cos(yaw) * Math.cos(pitch) * distance,
  ];
  const forward = normalize(vectorSubtract(target, camera));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));

  const cameraPoint = (point) => {
    const relative = vectorSubtract(point, camera);
    const depth = dot(relative, forward);
    const x = dot(relative, right);
    const y = dot(relative, up);
    return {
      x: perspective ? x / depth : x,
      y: perspective ? y / depth : y,
      depth,
    };
  };

  const all = [];
  for (const triangle of triangles) {
    for (const point of triangle.points) {
      all.push(cameraPoint(point));
    }
  }
  const usableWidth = width * (1 - padding * 2);
  const usableHeight = height * (1 - padding * 2);
  let scale;
  let centerX;
  let centerY;
  if (perspective && fovDegrees != null) {
    scale = height / (2 * Math.tan((fovDegrees * Math.PI) / 360));
    centerX = 0;
    centerY = 0;
  } else if (stableFraming) {
    const projectedTarget = cameraPoint(target);
    const referenceSpan = perspective ? 40 / cameraDistance : 40;
    scale = Math.min(usableWidth / referenceSpan, usableHeight / referenceSpan);
    centerX = projectedTarget.x;
    centerY = projectedTarget.y;
  } else {
    const minX = Math.min(...all.map((point) => point.x));
    const maxX = Math.max(...all.map((point) => point.x));
    const minY = Math.min(...all.map((point) => point.y));
    const maxY = Math.max(...all.map((point) => point.y));
    scale = Math.min(usableWidth / (maxX - minX), usableHeight / (maxY - minY));
    centerX = (minX + maxX) / 2;
    centerY = (minY + maxY) / 2;
  }

  const projectPoint = (point) => {
    const cameraSpace = cameraPoint(point);
    return [
      width / 2 + (cameraSpace.x - centerX) * scale,
      height / 2 - (cameraSpace.y - centerY) * scale,
      cameraSpace.depth,
    ];
  };

  return {
    triangles: triangles.map((triangle) => ({
      ...triangle,
      worldPoints: triangle.points,
      points: triangle.points.map(projectPoint),
      perspective,
    })),
    projectPoint,
  };
}

function parseBackground(background) {
  if (!background || background === "transparent") return [0, 0, 0, 0];
  const normalized = background.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(normalized)) {
    throw new Error("background must be 'transparent', RRGGBB, or RRGGBBAA.");
  }
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
    normalized.length === 8 ? Number.parseInt(normalized.slice(6, 8), 16) : 255,
  ];
}

function fillBackground(data, color) {
  for (let index = 0; index < data.length; index += 4) {
    data[index] = color[0];
    data[index + 1] = color[1];
    data[index + 2] = color[2];
    data[index + 3] = color[3];
  }
}

function correctedWeights(triangle, weights) {
  if (!triangle.perspective) return weights;
  const inverseDepth = weights[0] / triangle.points[0][2]
    + weights[1] / triangle.points[1][2]
    + weights[2] / triangle.points[2][2];
  return [
    (weights[0] / triangle.points[0][2]) / inverseDepth,
    (weights[1] / triangle.points[1][2]) / inverseDepth,
    (weights[2] / triangle.points[2][2]) / inverseDepth,
  ];
}

function buildShadowMap(triangles, texture, light, size = 384) {
  const target = [0, 16, 0];
  const camera = [
    target[0] + light[0] * 80,
    target[1] + light[1] * 80,
    target[2] + light[2] * 80,
  ];
  const forward = normalize(vectorSubtract(target, camera));
  const helperUp = Math.abs(forward[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(forward, helperUp));
  const up = normalize(cross(right, forward));
  const cameraPoint = (point) => {
    const relative = vectorSubtract(point, camera);
    return [dot(relative, right), dot(relative, up), dot(relative, forward)];
  };

  const points = triangles.flatMap((triangle) => triangle.points.map(cameraPoint));
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  const scale = Math.min((size - 8) / (maxX - minX), (size - 8) / (maxY - minY));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const project = (point) => {
    const value = cameraPoint(point);
    return [
      size / 2 + (value[0] - centerX) * scale,
      size / 2 - (value[1] - centerY) * scale,
      value[2],
    ];
  };

  const depth = new Float64Array(size * size);
  const surfaceIds = new Int32Array(size * size);
  const boxIds = new Int32Array(size * size);
  depth.fill(Number.POSITIVE_INFINITY);
  surfaceIds.fill(-1);
  boxIds.fill(-1);
  for (const source of triangles) {
    const sourceTexture = source.texture || texture;
    const points2d = source.points.map(project);
    const [a, b, c] = points2d;
    const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(denominator) < EPSILON) continue;
    const minPixelX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxPixelX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minPixelY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxPixelY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = minPixelY; y <= maxPixelY; y += 1) {
      for (let x = minPixelX; x <= maxPixelX; x += 1) {
        const w0 = ((b[1] - c[1]) * (x + 0.5 - c[0]) + (c[0] - b[0]) * (y + 0.5 - c[1])) / denominator;
        const w1 = ((c[1] - a[1]) * (x + 0.5 - c[0]) + (a[0] - c[0]) * (y + 0.5 - c[1])) / denominator;
        const w2 = 1 - w0 - w1;
        if (w0 < -EPSILON || w1 < -EPSILON || w2 < -EPSILON) continue;
        const u = Math.max(0, Math.min(sourceTexture.width - 1, Math.floor(
          w0 * source.uvs[0][0] + w1 * source.uvs[1][0] + w2 * source.uvs[2][0],
        )));
        const v = Math.max(0, Math.min(sourceTexture.height - 1, Math.floor(
          w0 * source.uvs[0][1] + w1 * source.uvs[1][1] + w2 * source.uvs[2][1],
        )));
        if (sourceTexture.data[(v * sourceTexture.width + u) * 4 + 3] === 0) continue;
        const value = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const index = y * size + x;
        if (value < depth[index]) {
          depth[index] = value;
          surfaceIds[index] = source.surfaceId;
          boxIds[index] = source.boxId;
        }
      }
    }
  }

  return { depth, surfaceIds, boxIds, size, project };
}

function shadowVisibility(worldPoint, shadowMap, receiverSurfaceId, receiverBoxId) {
  if (!shadowMap) return 1;
  const [x, y, depth] = shadowMap.project(worldPoint);
  const centerX = Math.round(x);
  const centerY = Math.round(y);
  let visible = 0;
  let samples = 0;
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const sampleX = centerX + offsetX;
      const sampleY = centerY + offsetY;
      if (sampleX < 0 || sampleY < 0 || sampleX >= shadowMap.size || sampleY >= shadowMap.size) continue;
      const index = sampleY * shadowMap.size + sampleX;
      const closest = shadowMap.depth[index];
      if (
        shadowMap.surfaceIds[index] === receiverSurfaceId
        || shadowMap.boxIds[index] === receiverBoxId
        || depth <= closest + 0.14
      ) visible += 1;
      samples += 1;
    }
  }
  return samples ? visible / samples : 1;
}

function rasterizeTriangle(triangle, target, depthBuffer, texture, light, shadowMap, shading) {
  const [a, b, c] = triangle.points;
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(denominator) < EPSILON) return;

  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxX = Math.min(target.width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(target.height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const directLight = Math.max(0, dot(triangle.normal, light));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / denominator;
      const w1 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / denominator;
      const w2 = 1 - w0 - w1;
      if (w0 < -EPSILON || w1 < -EPSILON || w2 < -EPSILON) continue;

      const weights = correctedWeights(triangle, [w0, w1, w2]);
      const [p0, p1, p2] = weights;
      const depth = p0 * a[2] + p1 * b[2] + p2 * c[2] - (triangle.depthBias || 0);
      const pixelIndex = y * target.width + x;
      if (depth >= depthBuffer[pixelIndex]) continue;

      const sourceTexture = triangle.texture || texture;
      const u = Math.max(0, Math.min(sourceTexture.width - 1, Math.floor(
        p0 * triangle.uvs[0][0] + p1 * triangle.uvs[1][0] + p2 * triangle.uvs[2][0],
      )));
      const v = Math.max(0, Math.min(sourceTexture.height - 1, Math.floor(
        p0 * triangle.uvs[0][1] + p1 * triangle.uvs[1][1] + p2 * triangle.uvs[2][1],
      )));
      const textureIndex = (v * sourceTexture.width + u) * 4;
      const sourceAlpha = sourceTexture.data[textureIndex + 3] / 255;
      if (sourceAlpha <= 0) continue;

      const worldPoint = [
        p0 * triangle.worldPoints[0][0] + p1 * triangle.worldPoints[1][0] + p2 * triangle.worldPoints[2][0],
        p0 * triangle.worldPoints[0][1] + p1 * triangle.worldPoints[1][1] + p2 * triangle.worldPoints[2][1],
        p0 * triangle.worldPoints[0][2] + p1 * triangle.worldPoints[1][2] + p2 * triangle.worldPoints[2][2],
      ];
      const visibility = 0.22 + 0.78 * shadowVisibility(
        worldPoint,
        shadowMap,
        triangle.surfaceId,
        triangle.boxId,
      );
      const faceX = p0 * triangle.faceCoords[0][0] + p1 * triangle.faceCoords[1][0] + p2 * triangle.faceCoords[2][0];
      const faceY = p0 * triangle.faceCoords[0][1] + p1 * triangle.faceCoords[1][1] + p2 * triangle.faceCoords[2][1];
      const edgeDistance = Math.min(faceX, 1 - faceX, faceY, 1 - faceY);
      const edgeShade = 0.9 + 0.1 * Math.min(1, edgeDistance / 0.035);
      const upwardFill = Math.max(0, triangle.normal[1]) * 0.06;
      const shade = shading
        ? Math.min(1.06, (0.5 + directLight * 0.5 * visibility + upwardFill) * edgeShade)
        : 1;

      const outputIndex = pixelIndex * 4;
      const destinationAlpha = target.data[outputIndex + 3] / 255;
      const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      const blend = outputAlpha === 0 ? 0 : sourceAlpha / outputAlpha;
      target.data[outputIndex] = clampByte(
        sourceTexture.data[textureIndex] * shade * blend + target.data[outputIndex] * (1 - blend),
      );
      target.data[outputIndex + 1] = clampByte(
        sourceTexture.data[textureIndex + 1] * shade * blend + target.data[outputIndex + 1] * (1 - blend),
      );
      target.data[outputIndex + 2] = clampByte(
        sourceTexture.data[textureIndex + 2] * shade * blend + target.data[outputIndex + 2] * (1 - blend),
      );
      target.data[outputIndex + 3] = Math.round(outputAlpha * 255);
      depthBuffer[pixelIndex] = depth;
    }
  }
}

function downsample(source, outputWidth, outputHeight, factor) {
  if (factor === 1) return source;
  const target = new PNG({ width: outputWidth, height: outputHeight });
  const samples = factor * factor;
  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const totals = [0, 0, 0];
      let totalAlpha = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const index = (((y * factor + sy) * source.width) + x * factor + sx) * 4;
          const alpha = source.data[index + 3] / 255;
          totals[0] += source.data[index] * alpha;
          totals[1] += source.data[index + 1] * alpha;
          totals[2] += source.data[index + 2] * alpha;
          totalAlpha += alpha;
        }
      }
      const outputIndex = (y * outputWidth + x) * 4;
      target.data[outputIndex] = totalAlpha ? Math.round(totals[0] / totalAlpha) : 0;
      target.data[outputIndex + 1] = totalAlpha ? Math.round(totals[1] / totalAlpha) : 0;
      target.data[outputIndex + 2] = totalAlpha ? Math.round(totals[2] / totalAlpha) : 0;
      target.data[outputIndex + 3] = Math.round((totalAlpha / samples) * 255);
    }
  }
  return target;
}

function blendColor(target, index, red, green, blue, alpha) {
  if (alpha <= 0) return;
  const destinationAlpha = target.data[index + 3] / 255;
  const outputAlpha = alpha + destinationAlpha * (1 - alpha);
  const sourceWeight = alpha / outputAlpha;
  target.data[index] = Math.round(red * sourceWeight + target.data[index] * (1 - sourceWeight));
  target.data[index + 1] = Math.round(green * sourceWeight + target.data[index + 1] * (1 - sourceWeight));
  target.data[index + 2] = Math.round(blue * sourceWeight + target.data[index + 2] * (1 - sourceWeight));
  target.data[index + 3] = Math.round(outputAlpha * 255);
}

function boxBlur(values, width, height, radius) {
  if (radius <= 0) return values;
  const horizontal = new Float32Array(values.length);
  const output = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += values[y * width + Math.max(0, Math.min(width - 1, x))];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / (radius * 2 + 1);
      const removeX = Math.max(0, x - radius);
      const addX = Math.min(width - 1, x + radius + 1);
      sum += values[y * width + addX] - values[y * width + removeX];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[Math.max(0, Math.min(height - 1, y)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / (radius * 2 + 1);
      const removeY = Math.max(0, y - radius);
      const addY = Math.min(height - 1, y + radius + 1);
      sum += horizontal[addY * width + x] - horizontal[removeY * width + x];
    }
  }
  return output;
}

function compositePresentation(model, background, shadow, groundPoint) {
  const output = new PNG({ width: model.width, height: model.height });
  fillBackground(output.data, background);
  if (shadow) {
    const radius = Math.max(2, Math.round(model.width * 0.009));
    const alpha = new Float32Array(model.width * model.height);
    for (let pixel = 0; pixel < alpha.length; pixel += 1) {
      alpha[pixel] = model.data[pixel * 4 + 3] / 255;
    }
    const blurred = boxBlur(boxBlur(alpha, model.width, model.height, Math.ceil(radius / 2)), model.width, model.height, radius);
    const offsetX = Math.round(model.width * 0.012);
    const offsetY = Math.round(model.height * 0.018);
    for (let y = 0; y < model.height; y += 1) {
      for (let x = 0; x < model.width; x += 1) {
        const sourceX = x - offsetX;
        const sourceY = y - offsetY;
        if (sourceX < 0 || sourceY < 0 || sourceX >= model.width || sourceY >= model.height) continue;
        const shadowAlpha = blurred[sourceY * model.width + sourceX] * 0.24;
        blendColor(output, (y * model.width + x) * 4, 12, 16, 24, shadowAlpha);
      }
    }

    const centerX = groundPoint[0];
    const centerY = groundPoint[1] + model.height * 0.006;
    const radiusX = model.width * 0.18;
    const radiusY = model.height * 0.035;
    const minX = Math.max(0, Math.floor(centerX - radiusX));
    const maxX = Math.min(model.width - 1, Math.ceil(centerX + radiusX));
    const minY = Math.max(0, Math.floor(centerY - radiusY));
    const maxY = Math.min(model.height - 1, Math.ceil(centerY + radiusY));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const distance = ((x - centerX) / radiusX) ** 2 + ((y - centerY) / radiusY) ** 2;
        if (distance >= 1) continue;
        const shadowAlpha = (1 - distance) ** 2 * 0.3;
        blendColor(output, (y * model.width + x) * 4, 9, 12, 18, shadowAlpha);
      }
    }
  }

  for (let index = 0; index < model.data.length; index += 4) {
    blendColor(
      output,
      index,
      model.data[index],
      model.data[index + 1],
      model.data[index + 2],
      model.data[index + 3] / 255,
    );
  }
  return output;
}

function applyLegacyHatTransparency(texture) {
  // Very old 64x32 skins often stored the unused hat area as opaque black.
  // Minecraft's own compatibility path makes the whole hat area transparent
  // when that area contains no alpha at all.
  const scale = texture.width / 64;
  let hasTransparency = false;
  for (let y = 0; y < 16 * scale && !hasTransparency; y += 1) {
    for (let x = 32 * scale; x < 64 * scale; x += 1) {
      if (texture.data[(y * texture.width + x) * 4 + 3] < 255) {
        hasTransparency = true;
        break;
      }
    }
  }
  if (hasTransparency) return;

  for (let y = 0; y < 16 * scale; y += 1) {
    for (let x = 32 * scale; x < 64 * scale; x += 1) {
      texture.data[(y * texture.width + x) * 4 + 3] = 0;
    }
  }
}

export function renderSkin(skinBuffer, options = {}) {
  let texture;
  try {
    texture = PNG.sync.read(skinBuffer);
  } catch {
    throw new Error("The request body is not a valid PNG image.");
  }

  if (texture.width % 64 !== 0) {
    throw new Error("Skin width must be 64px or a multiple of 64px.");
  }
  const textureScale = texture.width / 64;
  const legacy = texture.height === 32 * textureScale;
  if (!legacy && texture.height !== 64 * textureScale) {
    throw new Error("Skin dimensions must use the 64x64 or legacy 64x32 layout (HD multiples are allowed).");
  }
  if (legacy) applyLegacyHatTransparency(texture);

  const size = options.size ?? 1024;
  const width = options.width ?? size;
  const height = options.height ?? size;
  const antialias = options.antialias ?? (Math.max(width, height) <= 1024 ? 2 : 1);
  const renderWidth = width * antialias;
  const renderHeight = height * antialias;
  const isometric = options.isometric ?? false;
  const pose = options.emote
    ? sampleEmotePose(options.emote, options.frame)
    : getPose(options.pose ?? "showcase", options.frame);
  if (!pose) throw new Error(`Unknown pose '${options.pose}'.`);
  const cameraYaw = isometric ? TRUE_ISOMETRIC_YAW : (options.yaw ?? pose.cameraYaw ?? -10);
  const cameraPitch = isometric ? TRUE_ISOMETRIC_PITCH : (options.pitch ?? pose.cameraPitch ?? 12);
  if (pose.pointAtCamera) {
    pose[pose.pointAtCamera] = {
      x: (-(90 + cameraPitch) * Math.PI) / 180,
      y: ((cameraYaw + (pose.pointCameraYawOffset ?? 0)) * Math.PI) / 180,
      z: 0,
    };
  }

  const geometry = makeGeometry({
    slim: options.slim ?? false,
    texture,
    textureScale,
    overlay: options.overlay ?? true,
    layerStyle: options.layerStyle ?? "voxel",
    layerDepth: options.layerDepth ?? 1,
    legacy,
    pose,
    mode: options.mode ?? "fullbody",
    hiddenParts: new Set(
      (options.cosmetics || []).flatMap((cosmetic) => cosmetic.hiddenParts || []),
    ),
  });
  geometry.push(...makeEmotePropGeometry(pose));
  geometry.push(...makeCosmeticGeometry(options.cosmetics, pose, {
    animateCosmetics: options.animateCosmetics ?? false,
    frame: options.frame,
    poseName: options.emote ? `emote:${options.emote.name}` : (options.pose ?? "showcase"),
  }));
  // A true isometric view is orthographic and looks along a body diagonal of
  // the world cube: 45° around Y and atan(1/sqrt(2)) above the ground.
  const projection = projectGeometry(
    geometry,
    renderWidth,
    renderHeight,
    cameraYaw,
    cameraPitch,
    options.padding ?? 0.1,
    isometric ? false : (options.perspective ?? false),
    options.cameraDistance ?? 72,
    options.stableFraming ?? false,
    options.cameraTarget ?? (options.mode === "head" ? [0, 28, 0] : [0, 16, 0]),
    options.fov,
  );

  // Draw opaque base geometry before transparent outer skin layers. The depth
  // buffer still resolves overlaps between independently rotated body parts.
  projection.triangles.sort((a, b) => Number(a.layer) - Number(b.layer));
  const output = new PNG({ width: renderWidth, height: renderHeight });
  fillBackground(output.data, [0, 0, 0, 0]);
  const depthBuffer = new Float64Array(renderWidth * renderHeight);
  depthBuffer.fill(Number.POSITIVE_INFINITY);
  const light = normalize([-0.5, 0.9, 1.2]);
  const shading = options.shading ?? true;
  const shadowMap = options.shadow === false || !shading ? null : buildShadowMap(geometry, texture, light);
  for (const triangle of projection.triangles) {
    rasterizeTriangle(triangle, output, depthBuffer, texture, light, shadowMap, shading);
  }

  const model = downsample(output, width, height, antialias);
  const groundPoint = projection.projectPoint([0, 0, 0]).map((value) => value / antialias);
  const finalImage = compositePresentation(
    model,
    parseBackground(options.background),
    options.dropShadow ?? false,
    groundPoint,
  );
  return PNG.sync.write(finalImage, {
    colorType: 6,
    inputColorType: 6,
  });
}

export function renderFace(skinBuffer, options = {}) {
  return renderSkin(skinBuffer, {
    ...options,
    mode: "head",
    pose: "standing",
    yaw: 0,
    pitch: 0,
    padding: 0,
    isometric: false,
    perspective: false,
    layerStyle: options.overlay === false ? "none" : "flat",
    shading: false,
    shadow: false,
    dropShadow: false,
  });
}
