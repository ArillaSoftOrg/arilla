import { describe, expect, it } from "vitest";
import { type MascotStop, mascotPoseAt } from "./mascot-journey-motion.ts";

const stops: MascotStop[] = [
  { x: 750, y: 180, size: 480, scroll: 0 },
  { x: 950, y: 1000, size: 280, scroll: 700 },
  { x: 950, y: 1650, size: 280, scroll: 1350 },
];

describe("mascot journey", () => {
  it("stays at its reserved stops before and after the story", () => {
    expect(mascotPoseAt(stops, -100)).toMatchObject({ x: 750, y: 180, size: 480 });
    expect(mascotPoseAt(stops, 5000)).toMatchObject({ x: 950, y: 1650, size: 280 });
    expect(mascotPoseAt(stops, 700)).toMatchObject({ x: 950, y: 1000, size: 280 });
  });

  it("keeps the large hero character inside the right-hand lane as it shrinks", () => {
    for (let scroll = 0; scroll <= 700; scroll += 10) {
      const pose = mascotPoseAt(stops, scroll);
      expect(pose.x).toBeGreaterThanOrEqual(750);
      expect(pose.x + pose.size).toBeLessThanOrEqual(1230);
      expect(pose.size).toBeGreaterThanOrEqual(280);
      expect(pose.size).toBeLessThanOrEqual(480);
    }
  });

  it("stays in the reserved side lane between reading sections", () => {
    for (let scroll = 700; scroll <= 1350; scroll += 25) {
      const pose = mascotPoseAt(stops, scroll);
      expect(pose.x).toBe(950);
      expect(pose.size).toBe(280);
      expect(Math.abs(pose.rotation)).toBeLessThanOrEqual(5);
    }
  });

  it("handles missing or collapsed layout stops without invalid transforms", () => {
    expect(mascotPoseAt([], 0)).toEqual({ x: 0, y: 0, size: 0, rotation: 0 });
    const collapsed = { x: 0, y: 0, size: 220, scroll: 0 };
    for (const value of Object.values(mascotPoseAt([collapsed, collapsed], 0))) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
