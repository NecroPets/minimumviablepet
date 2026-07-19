import { join } from "node:path";
import { run } from "../exec.ts";
import { maskerAvailable } from "./masker.ts";

const POSE_SWIFT_PATH = join(import.meta.dir, "pose.swift");

export interface Anchor {
  x: number;
  y: number;
  conf: number;
}

export interface EarAnchor {
  tip: { x: number; y: number };
  mid: { x: number; y: number };
  base: { x: number; y: number };
  conf: number;
}

export interface RigAnchors {
  eye_l?: Anchor;
  eye_r?: Anchor;
  nose?: Anchor;
  ear_l?: EarAnchor;
  ear_r?: EarAnchor;
}

const EYE_CONF_FLOOR = 0.5;
const NOSE_CONF_FLOOR = 0.5;
const EAR_TOP_CONF_FLOOR = 0.4;

interface RawPoint {
  x: number;
  y: number;
  conf: number;
}

/** Parse one `pose.swift` stdout into the anchor contract the frontend reads.
 * PURE — no process spawning, so this is unit-testable without swift/macOS.
 * `no_animal_pose` (or anything else unparseable) yields no recognized
 * joints, which naturally falls through to {} below. */
export function parsePoseOutput(stdout: string): RigAnchors {
  const joints = new Map<string, RawPoint>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "no_animal_pose") continue;
    const fields = line.split("\t");
    if (fields.length !== 4) continue;
    const [name, xStr, yStr, confStr] = fields;
    const x = Number(xStr);
    const y = Number(yStr);
    const conf = Number(confStr);
    if (!name || Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(conf)) continue;
    joints.set(name, { x, y, conf });
  }

  const anchors: RigAnchors = {};

  const leftEye = joints.get("animal_joint_left_eye");
  if (leftEye && leftEye.conf >= EYE_CONF_FLOOR) {
    anchors.eye_l = { x: leftEye.x, y: leftEye.y, conf: leftEye.conf };
  }
  const rightEye = joints.get("animal_joint_right_eye");
  if (rightEye && rightEye.conf >= EYE_CONF_FLOOR) {
    anchors.eye_r = { x: rightEye.x, y: rightEye.y, conf: rightEye.conf };
  }
  const nose = joints.get("animal_joint_nose");
  if (nose && nose.conf >= NOSE_CONF_FLOOR) {
    anchors.nose = { x: nose.x, y: nose.y, conf: nose.conf };
  }

  const buildEar = (side: "left" | "right"): EarAnchor | undefined => {
    const top = joints.get(`animal_joint_${side}_ear_top`);
    const middle = joints.get(`animal_joint_${side}_ear_middle`);
    const bottom = joints.get(`animal_joint_${side}_ear_bottom`);
    if (!top || !middle || !bottom) return undefined;
    if (top.conf < EAR_TOP_CONF_FLOOR) return undefined;
    return {
      tip: { x: top.x, y: top.y },
      mid: { x: middle.x, y: middle.y },
      base: { x: bottom.x, y: bottom.y },
      conf: Math.min(top.conf, middle.conf, bottom.conf),
    };
  };
  const earL = buildEar("left");
  if (earL) anchors.ear_l = earL;
  const earR = buildEar("right");
  if (earR) anchors.ear_r = earR;

  return anchors;
}

/** Detect facial/ear anchors on an already-masked cutout via the macOS Vision
 * animal-pose helper (`pose.swift`). Pose is an OPTIONAL enhancement — Phase 1
 * (whole-cutout warp) works with no articulation at all — so this never
 * throws: no toolchain, or Vision finding nothing, both yield {}. */
export async function detectAnchors(cutoutPath: string): Promise<RigAnchors> {
  const swiftBin = Bun.which("swift");
  if (!maskerAvailable(process.platform, swiftBin)) {
    return {};
  }
  let stdout: string;
  try {
    stdout = await run([swiftBin as string, POSE_SWIFT_PATH, cutoutPath], { timeoutMs: 30_000 });
  } catch (err) {
    console.error(`pose detection [${cutoutPath}]: ${(err as Error).message.slice(0, 200)} — shipping without anchors`);
    return {};
  }
  return parsePoseOutput(stdout);
}
