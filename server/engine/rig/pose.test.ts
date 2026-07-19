import { describe, expect, test } from "bun:test";
import { parsePoseOutput } from "./pose.ts";

// Real sample output on Oni's cutout, verbatim (docs/EMBODIMENT-PLAN.md Phase 2).
const ONI_SAMPLE = [
  "animal_joint_left_ear_bottom\t0.8170\t0.0970\t0.66",
  "animal_joint_left_ear_middle\t0.8920\t0.0520\t0.72",
  "animal_joint_left_ear_top\t0.9767\t0.0198\t0.72",
  "animal_joint_left_eye\t0.7343\t0.1803\t0.92",
  "animal_joint_nose\t0.5964\t0.2572\t0.85",
  "animal_joint_right_ear_bottom\t0.3520\t0.1080\t0.79",
  "animal_joint_right_ear_middle\t0.3020\t0.0620\t0.81",
  "animal_joint_right_ear_top\t0.2340\t0.0208\t0.80",
  "animal_joint_right_eye\t0.4542\t0.1802\t0.91",
].join("\n");

describe("parsePoseOutput", () => {
  test("real sample: eye_l/eye_r/nose/ear_l/ear_r all present with correct coords", () => {
    const anchors = parsePoseOutput(ONI_SAMPLE);
    expect(anchors.eye_l).toEqual({ x: 0.7343, y: 0.1803, conf: 0.92 });
    expect(anchors.eye_r).toEqual({ x: 0.4542, y: 0.1802, conf: 0.91 });
    expect(anchors.nose).toEqual({ x: 0.5964, y: 0.2572, conf: 0.85 });
    expect(anchors.ear_l).toEqual({
      tip: { x: 0.9767, y: 0.0198 },
      mid: { x: 0.8920, y: 0.0520 },
      base: { x: 0.8170, y: 0.0970 },
      conf: 0.66, // min(0.72, 0.72, 0.66)
    });
    expect(anchors.ear_r).toEqual({
      tip: { x: 0.2340, y: 0.0208 },
      mid: { x: 0.3020, y: 0.0620 },
      base: { x: 0.3520, y: 0.1080 },
      conf: 0.79, // min(0.80, 0.81, 0.79)
    });
  });

  test("a low-confidence eye (conf 0.3) is omitted", () => {
    const stdout = [
      "animal_joint_left_eye\t0.7343\t0.1803\t0.3",
      "animal_joint_right_eye\t0.4542\t0.1802\t0.91",
    ].join("\n");
    const anchors = parsePoseOutput(stdout);
    expect(anchors.eye_l).toBeUndefined();
    expect(anchors.eye_r).toEqual({ x: 0.4542, y: 0.1802, conf: 0.91 });
  });

  test("no_animal_pose returns {}", () => {
    expect(parsePoseOutput("no_animal_pose")).toEqual({});
    expect(parsePoseOutput("no_animal_pose\n")).toEqual({});
  });

  test("an ear missing its 'bottom' joint is omitted", () => {
    const stdout = [
      "animal_joint_left_ear_top\t0.9767\t0.0198\t0.72",
      "animal_joint_left_ear_middle\t0.8920\t0.0520\t0.72",
      // no left_ear_bottom
      "animal_joint_right_ear_top\t0.2340\t0.0208\t0.80",
      "animal_joint_right_ear_middle\t0.3020\t0.0620\t0.81",
      "animal_joint_right_ear_bottom\t0.3520\t0.1080\t0.79",
    ].join("\n");
    const anchors = parsePoseOutput(stdout);
    expect(anchors.ear_l).toBeUndefined();
    expect(anchors.ear_r).toBeDefined();
  });

  test("empty stdout returns {}", () => {
    expect(parsePoseOutput("")).toEqual({});
  });

  test("an ear whose top confidence is below the 0.4 floor is omitted even with all three joints present", () => {
    const stdout = [
      "animal_joint_left_ear_top\t0.9767\t0.0198\t0.35",
      "animal_joint_left_ear_middle\t0.8920\t0.0520\t0.72",
      "animal_joint_left_ear_bottom\t0.8170\t0.0970\t0.66",
    ].join("\n");
    const anchors = parsePoseOutput(stdout);
    expect(anchors.ear_l).toBeUndefined();
  });
});
