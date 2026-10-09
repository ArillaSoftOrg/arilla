/**
 * Analitik merkez (karar 0085) — veritabanı gerektirmeyen kurallar: yetki
 * denetimi veriye dokunmadan önce, pencere süzgeci, küçük hücre gizleme.
 */
import type { Database } from "@arilla/db";
import { describe, expect, it } from "vitest";
import { getAffiliateOverview } from "./affiliate.ts";
import { getAiOperationsOverview, parseAnalyticsWindow } from "./ai-operations.ts";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import {
  getCatalogFreshness,
  getMatchingAccuracy,
  getSearchQualitySummary,
} from "./quality-insights.ts";
import { getUserJourneyOverview, SMALL_CELL_MIN, suppressSmallCell } from "./user-journey.ts";

/** Yetki reddi veritabanına hiç gitmeden olmalı: herhangi bir erişim test hatasıdır. */
const untouchable = new Proxy({} as Database, {
  get() {
    throw new Error("veritabanına erişildi");
  },
});

const moderator: AdminActor = { userId: 1, role: "moderator" };
const user: AdminActor = { userId: 2, role: "user" };

describe("yetki: yalnızca yönetici, veriden önce", () => {
  it.each([
    ["ai.read", () => getAiOperationsOverview(untouchable, moderator)],
    ["analytics.read", () => getUserJourneyOverview(untouchable, moderator)],
    ["affiliate.read", () => getAffiliateOverview(untouchable, moderator)],
  ])("moderatör %s ekranını göremez", async (capability, call) => {
    await expect(call()).rejects.toMatchObject({ name: "AdminForbiddenError", capability });
  });

  it("normal kullanıcı mevcut tanı özetlerini de göremez", async () => {
    await expect(getSearchQualitySummary(untouchable, user)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
    await expect(getMatchingAccuracy(untouchable, user)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
    await expect(getCatalogFreshness(untouchable, user)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
  });
});

describe("zaman penceresi", () => {
  it.each([
    ["1", 1],
    ["7", 7],
    ["30", 30],
    [30, 30],
  ])("%s geçerli", (raw, days) => {
    expect(parseAnalyticsWindow(raw)).toBe(days);
  });

  it.each(["0", "365", "-7", "7 gün", "", undefined, null, "1e1"])(
    "%s geçersiz → varsayılan (keyfi aralık yok)",
    (raw) => {
      expect(parseAnalyticsWindow(raw)).toBe(7);
      expect(parseAnalyticsWindow(raw, 30)).toBe(30);
    },
  );
});

describe("küçük hücre gizleme", () => {
  it(`${SMALL_CELL_MIN} kişiden az: olay ve kişi sayısı gizli`, () => {
    expect(suppressSmallCell("search_submitted", 40, SMALL_CELL_MIN - 1)).toEqual({
      kind: "search_submitted",
      events: null,
      users: null,
      suppressed: true,
    });
  });

  it(`${SMALL_CELL_MIN} ve üstü: gösterilir`, () => {
    expect(suppressSmallCell("merchant_exit", 12, SMALL_CELL_MIN)).toEqual({
      kind: "merchant_exit",
      events: 12,
      users: SMALL_CELL_MIN,
      suppressed: false,
    });
  });
});
