/**
 * Faz D yönetim özellikleri (karar 0086) — birim. Yetki reddi veritabanına
 * dokunmadan olur; geçiş kuralları ve yapılandırma görünümünün sır güvenliği.
 */
import type { Database } from "@arilla/db";
import { describe, expect, it } from "vitest";
import { type AdminActor, AdminForbiddenError } from "./capabilities.ts";
import { getConfigView } from "./config-view.ts";
import { listEarlyAccessApplications } from "./early-access.ts";
import {
  allowedInboxTransitions,
  INBOX_STATUSES,
  InboxValidationError,
  setInboxMessagePriority,
  setInboxMessageStatus,
} from "./messages.ts";
import {
  allowedTrendTransitions,
  listTrendsForAdmin,
  moveTrend,
  setTrendFeatured,
  setTrendStatus,
  TrendValidationError,
  trendWindowState,
} from "./trends-admin.ts";

/** Dokunulursa test kırılır: reddin veritabanından ÖNCE olduğunu kanıtlar. */
const untouchable = new Proxy({} as Database, {
  get() {
    throw new Error("veritabanına dokunuldu");
  },
});

const admin: AdminActor = { userId: 1, role: "admin" };
const DENIED: AdminActor[] = [
  { userId: 2, role: "moderator" },
  { userId: 3, role: "creator" },
  { userId: 4, role: "user" },
];

describe("yetki reddi veritabanından önce (karar 0086)", () => {
  const calls: [string, (actor: AdminActor) => unknown][] = [
    ["listTrendsForAdmin", (a) => listTrendsForAdmin(untouchable, a)],
    [
      "setTrendStatus",
      (a) =>
        setTrendStatus(untouchable, a, {
          trendId: 1,
          next: "published",
          expectedStatus: "draft",
          reason: "geçerli gerekçe",
        }),
    ],
    [
      "setTrendFeatured",
      (a) => setTrendFeatured(untouchable, a, { trendId: 1, featured: true, reason: "gerekçe" }),
    ],
    [
      "moveTrend",
      (a) => moveTrend(untouchable, a, { trendId: 1, direction: "up", reason: "gerekçe" }),
    ],
    [
      "setInboxMessageStatus",
      (a) =>
        setInboxMessageStatus(untouchable, a, {
          messageId: 1,
          next: "reviewing",
          expectedStatus: "new",
        }),
    ],
    [
      "setInboxMessagePriority",
      (a) => setInboxMessagePriority(untouchable, a, { messageId: 1, priority: "high" }),
    ],
    ["listEarlyAccessApplications", (a) => listEarlyAccessApplications(untouchable, a)],
    ["getConfigView", (a) => getConfigView(a, {})],
  ];
  for (const [name, call] of calls) {
    for (const actor of DENIED) {
      it(`${name} - ${actor.role}`, async () => {
        await expect(async () => call(actor)).rejects.toBeInstanceOf(AdminForbiddenError);
      });
    }
  }
});

describe("trend doğrulaması veritabanından önce", () => {
  it("gerekçe zorunlu ve sınırlı", async () => {
    for (const reason of [undefined, "", "   ", "abcd", "x".repeat(501)]) {
      await expect(
        setTrendFeatured(untouchable, admin, { trendId: 1, featured: true, reason }),
      ).rejects.toBeInstanceOf(TrendValidationError);
    }
  });

  it("izinsiz geçiş, geçersiz kimlik ve yön reddedilir", async () => {
    await expect(
      setTrendStatus(untouchable, admin, {
        trendId: 1,
        next: "published",
        expectedStatus: "archived",
        reason: "arşivden doğrudan yayın",
      }),
    ).rejects.toBeInstanceOf(TrendValidationError);
    await expect(
      setTrendStatus(untouchable, admin, {
        trendId: -1,
        next: "published",
        expectedStatus: "draft",
        reason: "geçersiz kimlik",
      }),
    ).rejects.toBeInstanceOf(TrendValidationError);
    await expect(
      moveTrend(untouchable, admin, { trendId: 1, direction: "sideways", reason: "geçersiz yön" }),
    ).rejects.toBeInstanceOf(TrendValidationError);
    await expect(
      setTrendFeatured(untouchable, admin, { trendId: 1, featured: "true", reason: "metin değer" }),
    ).rejects.toBeInstanceOf(TrendValidationError);
  });

  it("geçiş tablosu: arşivden yalnızca taslağa", () => {
    expect(allowedTrendTransitions("draft").sort()).toEqual(["archived", "published"]);
    expect(allowedTrendTransitions("published").sort()).toEqual(["archived", "draft"]);
    expect(allowedTrendTransitions("archived")).toEqual(["draft"]);
  });

  it("yayın penceresi durumu", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const past = new Date("2026-10-01T00:00:00Z");
    const future = new Date("2026-10-20T00:00:00Z");
    expect(trendWindowState(null, null, now)).toBe("none");
    expect(trendWindowState(future, null, now)).toBe("upcoming");
    expect(trendWindowState(past, future, now)).toBe("open");
    expect(trendWindowState(null, past, now)).toBe("ended");
  });
});

describe("gelen kutusu geçişleri", () => {
  it("kapanmış mesaj yalnızca incelemeye geri açılır; kendine geçiş yok", () => {
    expect(allowedInboxTransitions("resolved")).toEqual(["reviewing"]);
    expect(allowedInboxTransitions("rejected")).toEqual(["reviewing"]);
    for (const status of INBOX_STATUSES) {
      expect(allowedInboxTransitions(status)).not.toContain(status);
    }
  });

  it("izinsiz geçiş ve geçersiz değerler veritabanından önce reddedilir", async () => {
    await expect(
      setInboxMessageStatus(untouchable, admin, {
        messageId: 1,
        next: "planned",
        expectedStatus: "resolved",
      }),
    ).rejects.toBeInstanceOf(InboxValidationError);
    await expect(
      setInboxMessageStatus(untouchable, admin, {
        messageId: 1,
        next: "done",
        expectedStatus: "new",
      }),
    ).rejects.toBeInstanceOf(InboxValidationError);
    await expect(
      setInboxMessagePriority(untouchable, admin, { messageId: 1, priority: "urgent" }),
    ).rejects.toBeInstanceOf(InboxValidationError);
    await expect(
      setInboxMessagePriority(untouchable, admin, { messageId: "1", priority: "high" }),
    ).rejects.toBeInstanceOf(InboxValidationError);
  });
});

describe("yapılandırma görünümü: sır değeri asla dönmez", () => {
  const SECRETS: Record<string, string> = {
    GEMINI_API_KEY: "gem-SIR-123456",
    JINA_API_KEY: "jina-SIR-654321",
    SESSION_SECRET: "oturum-SIR-abcdef",
    CRON_SECRET: "cron-SIR-fedcba",
    SMTP_HOST: "smtp.SIR.example",
    SMTP_USER: "smtp-kullanici-SIR",
    SMTP_PASS: "smtp-parola-SIR",
    GOOGLE_CLIENT_ID: "google-id-SIR",
    GOOGLE_CLIENT_SECRET: "google-SIR",
    // PEM başlıkları parçalı: depo tarayıcısı (check:secrets) gerçek anahtar sanmasın.
    APPLE_PRIVATE_KEY: `${"-----BEGIN"} PRIVATE KEY-----SIR`,
    NETGSM_PASSWORD: "netgsm-SIR",
    DATABASE_URL: "postgres://kullanici:parola-SIR@db.example:5432/arilla",
    REDIS_URL: "rediss://default:redis-SIR@cache.example:6379",
    R2_SECRET_ACCESS_KEY: "r2-SIR",
    MARKETING_TEST_RECIPIENTS: "kisi-SIR@example.test, ikinci-SIR@example.test",
    GA4_CLIENT_EMAIL: "sir-okur@sir-proje.iam.gserviceaccount.com",
    GA4_PRIVATE_KEY: `${"-----BEGIN"} PRIVATE KEY-----\\nSIRSIRSIR\\n-----END PRIVATE KEY-----`,
  };

  it("hiçbir çıktıda sır parçası geçmez; sırlar yalnızca durum taşır", () => {
    const view = getConfigView(admin, { ...SECRETS, CHAT_DISCOVERY_ENABLED: "true" });
    const json = JSON.stringify(view);
    expect(json).not.toContain("SIR");
    for (const entry of view.entries.filter((e) => e.secret)) {
      expect(entry.value).toBeNull();
    }
    const byKey = new Map(view.entries.map((e) => [e.key, e]));
    expect(byKey.get("GEMINI_API_KEY")?.state).toBe("set");
    expect(byKey.get("NETGSM_USERCODE")?.state).toBe("missing");
    expect(byKey.get("MARKETING_TEST_RECIPIENTS")?.note).toBe("2 adres");
    expect(byKey.get("CHAT_DISCOVERY_ENABLED")?.value).toBe("Açık");
  });

  it("tanımsız, geçersiz ve bilinmeyen ayrılır", () => {
    const view = getConfigView(admin, {
      DATABASE_URL: "bir url değil",
      CHAT_TURNS_PER_HOUR: "çok",
      LLM_COST_TRY_PER_USD: "-3",
      GEMINI_REALTIME_ENABLED: "true",
    });
    const byKey = new Map(view.entries.map((e) => [e.key, e]));
    expect(byKey.get("DATABASE_URL")).toMatchObject({ state: "invalid", value: null });
    expect(byKey.get("REDIS_URL")?.state).toBe("missing");
    expect(byKey.get("CHAT_TURNS_PER_HOUR")?.state).toBe("invalid");
    expect(byKey.get("LLM_COST_TRY_PER_USD")).toMatchObject({ state: "invalid", value: null });
    expect(byKey.get("MATCH_AUTO_ACCEPT_THRESHOLD")?.state).toBe("unknown");
    expect(byKey.get("AI_SEARCH_DAILY_LIMIT")?.state).toBe("default");
    // Bayrak açık ama anahtar yok: etkin değer kapalı ve not düşülür.
    expect(byKey.get("GEMINI_REALTIME_ENABLED")).toMatchObject({ value: "Kapalı" });
    expect(byKey.get("GEMINI_REALTIME_ENABLED")?.note).toBeTruthy();
  });

  it("anahtarlar benzersiz", () => {
    const keys = getConfigView(admin, {}).entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
