import { describe, expect, it } from "vitest";
import {
  HIDE_UP_PX,
  initialScrollTrack,
  isFloatingVisible,
  resetScrollTrack,
  type ScrollTrack,
  SHOW_DOWN_PX,
  trackScroll,
} from "./floating-composer-state.ts";

const MAX = 5000;

function scroll(positions: number[], start = 0): ScrollTrack {
  return positions.reduce((state, y) => trackScroll(state, y, MAX), initialScrollTrack(start));
}

describe("trackScroll (karar 0093)", () => {
  it("asagi kaydirma esigi asinca gosterir, altinda gostermez", () => {
    expect(scroll([SHOW_DOWN_PX - 1]).shown).toBe(false);
    expect(scroll([SHOW_DOWN_PX]).shown).toBe(true);
  });

  it("yukari en az 24px gizler; daha azi gizlemez", () => {
    expect(scroll([600, 600 - (HIDE_UP_PX - 1)]).shown).toBe(true);
    expect(scroll([600, 600 - HIDE_UP_PX]).shown).toBe(false);
  });

  it("esik yon degistigi noktadan olculur (adim adim yukari kaydirma birikir)", () => {
    // Donus noktasi 600: 5px'lik adimlar birikir.
    expect(scroll([600, 595, 590, 585, 580]).shown).toBe(true); // 20px < 24
    expect(scroll([600, 595, 590, 585, 580, 575]).shown).toBe(false); // 25px >= 24
  });

  it("yukari sonra tekrar asagi kaydirma yeniden gosterir", () => {
    const hidden = scroll([600, 500]);
    expect(hidden.shown).toBe(false);
    expect(trackScroll(hidden, 500 + SHOW_DOWN_PX, MAX).shown).toBe(true);
  });

  it("iOS lastik ziplamasi: sinir disi konum kirpilir, en altta geri sekme gizlemez", () => {
    const atBottom = scroll([4000, MAX]);
    expect(atBottom.shown).toBe(true);
    // Ziplama: MAX+40 -> MAX (kirpilinca hareket yok).
    const bounced = trackScroll(trackScroll(atBottom, MAX + 40, MAX), MAX, MAX);
    expect(bounced.shown).toBe(true);
    // Ust sinir: negatif konum 0'a kirpilir.
    expect(trackScroll(initialScrollTrack(0), -30, MAX)).toEqual(initialScrollTrack(0));
  });

  it("reset sonrasi yeniden asagi kaydirma gerekir", () => {
    const reset = resetScrollTrack(scroll([600]));
    expect(reset.shown).toBe(false);
    expect(trackScroll(reset, 600 + SHOW_DOWN_PX, MAX).shown).toBe(true);
  });
});

describe("isFloatingVisible", () => {
  const base = {
    scrollShown: true,
    mainVisible: false,
    dismissed: false,
    bannerVisible: false,
    focused: false,
  };

  it("ana kutu gorunmez ve kaydirma istiyorsa gorunur", () => {
    expect(isFloatingVisible(base)).toBe(true);
  });

  it("ana kutu gorunurken gizli", () => {
    expect(isFloatingVisible({ ...base, mainVisible: true })).toBe(false);
  });

  it("kapatildiysa ya da cerez bandi varsa her durumda gizli (odakli olsa da)", () => {
    expect(isFloatingVisible({ ...base, dismissed: true, focused: true })).toBe(false);
    expect(isFloatingVisible({ ...base, bannerVisible: true, focused: true })).toBe(false);
  });

  it("odak icerdeyken kaydirma ya da klavye gorunum degisikligi gizlemez", () => {
    expect(isFloatingVisible({ ...base, scrollShown: false, focused: true })).toBe(true);
    expect(isFloatingVisible({ ...base, mainVisible: true, focused: true })).toBe(true);
  });
});
