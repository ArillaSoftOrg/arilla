import { describe, expect, it } from "vitest";
import {
  distanceFromBottom,
  keyboardInsetPx,
  NEAR_BOTTOM_PX,
  shouldAutoScroll,
} from "./chat-scroll.ts";

describe("distanceFromBottom", () => {
  it("is the remaining scroll distance, never negative", () => {
    expect(distanceFromBottom(2000, 1000, 800)).toBe(200);
    expect(distanceFromBottom(2000, 1200, 800)).toBe(0);
    expect(distanceFromBottom(1000, 400, 800)).toBe(0); // iOS aşırı kaydırma
  });
});

describe("shouldAutoScroll", () => {
  it("always scrolls when the user just sent a message or the page opens", () => {
    expect(shouldAutoScroll({ userJustSent: true, initial: false, distanceFromBottom: 5000 })).toBe(
      true,
    );
    expect(shouldAutoScroll({ userJustSent: false, initial: true, distanceFromBottom: 5000 })).toBe(
      true,
    );
  });
  it("follows new content only when the reader is already near the bottom", () => {
    const base = { userJustSent: false, initial: false };
    expect(shouldAutoScroll({ ...base, distanceFromBottom: 0 })).toBe(true);
    expect(shouldAutoScroll({ ...base, distanceFromBottom: NEAR_BOTTOM_PX })).toBe(true);
    expect(shouldAutoScroll({ ...base, distanceFromBottom: NEAR_BOTTOM_PX + 1 })).toBe(false);
    expect(shouldAutoScroll({ ...base, distanceFromBottom: 900 })).toBe(false);
  });
  it("honours a custom threshold", () => {
    expect(
      shouldAutoScroll({
        userJustSent: false,
        initial: false,
        distanceFromBottom: 200,
        threshold: 300,
      }),
    ).toBe(true);
  });
});

describe("keyboardInsetPx", () => {
  it("is zero without a keyboard and for sub-pixel noise", () => {
    expect(keyboardInsetPx(800, { height: 800, offsetTop: 0 })).toBe(0);
    expect(keyboardInsetPx(800, { height: 799.5, offsetTop: 0 })).toBe(0);
  });
  it("is the space the keyboard covers", () => {
    expect(keyboardInsetPx(800, { height: 480, offsetTop: 0 })).toBe(320);
  });
  it("accounts for the visual viewport being scrolled (iOS pan)", () => {
    expect(keyboardInsetPx(800, { height: 480, offsetTop: 100 })).toBe(220);
  });
  it("never goes negative (pinch zoom, URL bar collapse)", () => {
    expect(keyboardInsetPx(800, { height: 820, offsetTop: 0 })).toBe(0);
  });
});
