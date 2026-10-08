/**
 * Arama hakki metinleri: tek satir ozet en kisitlayici pencereyi gosterir,
 * dolan pencereye gore dogru yenilenme metni ve bonus baglantisi.
 */
import { describe, expect, it } from "vitest";
import {
  linkFailureCopy,
  linkNoRightsCode,
  linkNoRightsEarnable,
} from "./link/link-search-copy.ts";
import {
  bonusCanHelp,
  SEARCH_RIGHTS_NO_RIGHTS,
  searchRightsHint,
  searchRightsSummary,
} from "./search-rights-copy.ts";

const RESET = new Date("2026-10-08T21:00:00Z");

function status(input: {
  hour?: number;
  day?: number;
  week?: number;
  month?: number;
  bonus?: number;
}) {
  const windows = {
    hour: { remaining: input.hour ?? 10, limit: 10 },
    day: { remaining: input.day ?? 30, limit: 30 },
    week: { remaining: input.week ?? 120, limit: 120 },
    month: { remaining: input.month ?? 350, limit: 350 },
  };
  const limitingWindow = (["month", "week", "day"] as const).reduce((best, window) =>
    windows[window].remaining < windows[best].remaining ? window : best,
  );
  return {
    windows,
    limitingWindow,
    periodRemaining: windows[limitingWindow].remaining,
    bonus: input.bonus ?? 0,
    nextResetAt: RESET,
  };
}

describe("searchRightsSummary", () => {
  it("varsayilan: bugun kalan / gunluk limit", () => {
    expect(searchRightsSummary(status({ day: 27, bonus: 4 }))).toBe("Bugün kalan 27/30 · Bonus 4");
  });

  it("hafta ya da ay daha az birakirsa o gosterilir", () => {
    expect(searchRightsSummary(status({ day: 27, week: 5 }))).toBe(
      "Bu hafta kalan 5/120 · Bonus 0",
    );
    expect(searchRightsSummary(status({ day: 27, week: 50, month: 2 }))).toBe(
      "Bu ay kalan 2/350 · Bonus 0",
    );
  });
});

describe("searchRightsHint", () => {
  it("hak varken gunluk yenilenme saati", () => {
    expect(searchRightsHint(status({ day: 12 }))).toEqual({
      text: "Günlük hakların 00:00'da yenilenir.",
      exhaustedWindow: null,
    });
  });

  it("haftalik/aylik pencere sinirlarken onun yenilenmesi", () => {
    expect(searchRightsHint(status({ week: 3 })).text).toBe(
      "Haftalık hakların pazartesi 00:00'da yenilenir.",
    );
    expect(searchRightsHint(status({ month: 3 })).text).toBe(
      "Aylık hakların ayın 1'inde 00:00'da yenilenir.",
    );
  });

  it("saatlik sinir dolunca bonus olsa da saat metni; bonus baglantisi yok", () => {
    const hint = searchRightsHint(status({ hour: 0, bonus: 20 }));
    expect(hint).toEqual({ text: SEARCH_RIGHTS_NO_RIGHTS.hour, exhaustedWindow: "hour" });
    expect(bonusCanHelp("hour")).toBe(false);
  });

  it("donem ve bonus bitince dolan pencerenin metni; bonus baglantisi var", () => {
    expect(searchRightsHint(status({ day: 0 }))).toEqual({
      text: SEARCH_RIGHTS_NO_RIGHTS.day,
      exhaustedWindow: "day",
    });
    expect(searchRightsHint(status({ day: 10, week: 0 })).exhaustedWindow).toBe("week");
    expect(searchRightsHint(status({ day: 10, week: 10, month: 0 })).exhaustedWindow).toBe("month");
    for (const window of ["day", "week", "month"] as const) expect(bonusCanHelp(window)).toBe(true);
  });

  it("donem bitti ama bonus var: dolu sayilmaz", () => {
    expect(searchRightsHint(status({ day: 0, bonus: 3 })).exhaustedWindow).toBeNull();
  });
});

describe("metin kurallari", () => {
  it("buyuk harf ve yasakli kelime yok", () => {
    for (const text of Object.values(SEARCH_RIGHTS_NO_RIGHTS)) {
      expect(text).not.toMatch(/[A-ZÇĞİÖŞÜ]{3,}/);
      expect(text.toLocaleLowerCase("tr")).not.toMatch(/satın al|dupe|ucuz/);
    }
  });
});

describe("link aramasi (kapali; acilinca ayni havuz)", () => {
  it("gunluk dolum eski kodu korur, digerleri ayri kod ve metin", () => {
    expect(linkNoRightsCode("day")).toBe("no_rights");
    expect(linkNoRightsCode("hour")).toBe("no_rights_hour");
    expect(linkNoRightsCode("week")).toBe("no_rights_week");
    expect(linkNoRightsCode("month")).toBe("no_rights_month");
    expect(linkFailureCopy("no_rights_week").title).toBe("Bu haftaki arama hakların bitti.");
    expect(linkFailureCopy("no_rights_hour").title).toBe("Bu saat için arama sınırına ulaştın.");
    expect(linkNoRightsEarnable("no_rights_hour")).toBe(false);
    expect(linkNoRightsEarnable("no_rights_month")).toBe(true);
  });
});
