const degrees = (value) => (value * Math.PI) / 180;

const cycle = (frame) => Math.sin(frame * Math.PI * 2);

/**
 * Every angle is expressed in radians. X swings a limb forwards/backwards,
 * Z moves it sideways. A frame is normalized to the range 0..1.
 */
export const POSES = Object.freeze({
  showcase: {
    description: "Relaxed full-body showcase pose",
    defaultFrame: 0,
    build: () => ({
      head: { x: degrees(-2), y: degrees(-3) },
      rightArm: { x: degrees(-3), z: degrees(-5) },
      leftArm: { x: degrees(3), z: degrees(5) },
      rightLeg: { x: degrees(1), z: degrees(-1) },
      leftLeg: { x: degrees(-1), z: degrees(1) },
    }),
  },
  idle: {
    description: "Relaxed, asymmetric idle pose",
    defaultFrame: 0.15,
    build: (frame) => {
      const breath = cycle(frame);
      return {
        upperLean: degrees(2),
        head: { x: degrees(-3), y: degrees(-9), z: degrees(-2) },
        body: { y: degrees(4) },
        rightArm: { x: degrees(-8 - breath * 2), z: degrees(-5) },
        leftArm: { x: degrees(6 + breath * 2), z: degrees(6) },
        rightLeg: { x: degrees(4), z: degrees(-2) },
        leftLeg: { x: degrees(-3), z: degrees(2) },
      };
    },
  },
  standing: {
    description: "Neutral standing pose",
    defaultFrame: 0,
    build: () => ({
      rightArm: { x: degrees(2), z: degrees(2) },
      leftArm: { x: degrees(-2), z: degrees(-2) },
    }),
  },
  walking: {
    description: "Natural walking cycle",
    defaultFrame: 0.25,
    build: (frame) => {
      const swing = cycle(frame);
      const bounce = Math.cos(frame * Math.PI * 4);
      return {
        upperOffset: { y: bounce * 0.1 },
        rightArm: { x: degrees(32) * swing },
        leftArm: { x: degrees(-32) * swing },
        rightLeg: { x: degrees(-28) * swing },
        leftLeg: { x: degrees(28) * swing },
        body: { y: degrees(2) * swing, z: degrees(swing) },
        head: { z: degrees(-swing * 0.75) },
      };
    },
  },
  marching: {
    description: "Pronounced marching step",
    defaultFrame: 0.2,
    build: (frame) => {
      const swing = cycle(frame);
      const bounce = Math.cos(frame * Math.PI * 4);
      return {
        upperOffset: { y: bounce * 0.16 },
        rightArm: { x: degrees(42) * swing },
        leftArm: { x: degrees(-42) * swing },
        rightLeg: { x: degrees(-48) * swing },
        leftLeg: { x: degrees(48) * swing },
        body: { x: degrees(3), z: degrees(swing * 1.5) },
        head: { z: degrees(-swing) },
      };
    },
  },
  running: {
    description: "Dynamic running cycle",
    defaultFrame: 0.25,
    build: (frame) => {
      const swing = cycle(frame);
      const bounce = Math.cos(frame * Math.PI * 4);
      return {
        upperLean: degrees(10),
        upperOffset: { y: bounce * 0.22, z: 0.5 },
        rightArm: { x: degrees(44) * swing },
        leftArm: { x: degrees(-44) * swing },
        rightLeg: { x: degrees(-42) * swing },
        leftLeg: { x: degrees(42) * swing },
        body: { z: degrees(swing * 2) },
        head: { x: degrees(-3), z: degrees(-swing * 1.5) },
      };
    },
  },
  crouching: {
    description: "Sneaking/crouching pose",
    defaultFrame: 0,
    build: (frame) => {
      const breath = cycle(frame);
      return {
        upperLean: degrees(12 + breath),
        upperOffset: { y: -3.2 + breath * 0.08, z: 0.5 },
        rightArm: { x: degrees(-8 - breath * 2) },
        leftArm: { x: degrees(-8 + breath * 2) },
        rightLeg: { x: 0 },
        leftLeg: { x: 0 },
      };
    },
  },
  cheering: {
    description: "Both arms raised in celebration",
    defaultFrame: 0,
    build: (frame) => {
      const bounce = cycle(frame);
      return {
        upperOffset: { y: bounce * 0.12 },
        shoulderDrop: 4,
        rightArm: { x: degrees(-7), z: degrees(-118 - bounce * 3) },
        leftArm: { x: degrees(-7), z: degrees(118 + bounce * 3) },
        rightLeg: { z: degrees(-4) },
        leftLeg: { z: degrees(4) },
        head: { x: degrees(-6), z: degrees(bounce * 2) },
      };
    },
  },
  waving: {
    description: "One raised arm waving",
    defaultFrame: 0,
    build: (frame) => {
      const wave = cycle(frame);
      const followThrough = Math.cos(frame * Math.PI * 2);
      return {
        upperOffset: { y: followThrough * 0.06 },
        leftShoulderDrop: 2,
        leftArm: {
          x: degrees(-8 + followThrough * 3),
          y: degrees(wave * 4),
          z: degrees(118 + wave * 12),
        },
        rightArm: { x: degrees(-3 - wave * 1.5), z: degrees(-4) },
        body: { z: degrees(-wave * 0.75) },
        head: { y: degrees(-8), z: degrees(-wave * 2) },
      };
    },
  },
  pointing: {
    description: "One arm pointing forwards",
    defaultFrame: 0,
    build: () => ({
      cameraYaw: 0,
      rightShoulderDrop: 3.25,
      pointAtCamera: "rightArm",
      pointCameraYawOffset: -14,
      leftArm: { x: degrees(2), z: degrees(3) },
      head: { x: 0, y: 0, z: 0 },
    }),
  },
  sitting: {
    description: "Seated pose",
    defaultFrame: 0,
    build: () => ({
      frontSoles: true,
      coverLegTops: true,
      legInset: 1.75,
      upperLean: degrees(-5),
      upperOffset: { y: -0.35, z: -0.35 },
      rightLeg: { x: degrees(-78) },
      leftLeg: { x: degrees(-78) },
      rightArm: { x: degrees(-10), z: degrees(-2) },
      leftArm: { x: degrees(-10), z: degrees(2) },
    }),
  },
});

export function getPose(name, frame) {
  const definition = POSES[name];
  if (!definition) return null;
  const actualFrame = frame == null ? definition.defaultFrame : frame;
  return definition.build(actualFrame);
}

export function listPoses() {
  return Object.entries(POSES).map(([name, pose]) => ({
    name,
    description: pose.description,
    defaultFrame: pose.defaultFrame,
  }));
}
