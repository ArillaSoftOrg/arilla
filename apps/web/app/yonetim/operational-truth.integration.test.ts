/**
 * Karar 0051 — yönetim ekranının dürüst ölçütleri, sayfalar gerçek HTML'e
 * çevrilerek (yerel Postgres; `next/*` taklit). Yetki sınırları DEĞİŞMEDİ:
 * kartlar aynı rollere görünür, bağlantı yalnızca rolün açabildiği sayfaya.
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
  }),
  headers: async () => new Headers(),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
class NotFoundSignal extends Error {
  constructor() {
    super("notFound");
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new NotFoundSignal();
  },
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

function assertLocal(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} tanımlı değil`);
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`${name} yerel değil (${host}); bu test yalnızca yerel veritabanında çalışır.`);
  }
  return url;
}

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let ownerPool: OwnerClient | undefined;

async function owner<T>(fn: (client: OwnerClient) => Promise<T>): Promise<T> {
  ownerPool ??= createDatabase(assertLocal("DATABASE_URL_OWNER")).$client;
  return fn(ownerPool);
}

const TAG = `wot${Date.now().toString(36)}`;
const tokens: Record<string, string> = {};
const userIds: number[] = [];
const merchantIds: number[] = [];
const usageIds: number[] = [];

async function html(element: Promise<unknown>): Promise<string> {
  return renderToStaticMarkup((await element) as ReactElement);
}

async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (error) {
    if (error instanceof NotFoundSignal) return "404";
    if (error instanceof RedirectSignal) return "redirect";
    throw error;
  }
}

const dashboard = async () => (await import("./page.tsx")).default();
const operations = async () =>
  (await import("./islemler/page.tsx")).default({ searchParams: Promise.resolve({}) });
const jobRuns = async (params: Record<string, string> = {}) =>
  (await import("./islemler/isler/page.tsx")).default({ searchParams: Promise.resolve(params) });
const ingest = async (durum?: string) =>
  (await import("./ingest/page.tsx")).default({ searchParams: Promise.resolve({ durum }) });
const audit = async (params: Record<string, string>) =>
  (await import("./denetim/page.tsx")).default({ searchParams: Promise.resolve(params) });

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    for (const role of ["moderator", "admin"] as const) {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id",
        [`${TAG}-${role}@test.local`, role],
      );
      const id = Number(res.rows[0].id);
      userIds.push(id);
      const raw = generateRawToken();
      tokens[role] = raw;
      await client.query(
        "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [id, hashToken(raw)],
      );
    }
    for (const [key, active] of [
      ["broken", true],
      ["off", false],
    ] as const) {
      const res = await client.query(
        `INSERT INTO merchant (slug, name, domain, source_type, is_active)
         VALUES ($1, $2, $3, 'xml_feed', $4) RETURNING id`,
        [`${TAG}-${key}`, `${TAG} ${key}`, `${TAG}-${key}.test`, active],
      );
      const id = Number(res.rows[0].id);
      merchantIds.push(id);
      await client.query(
        `INSERT INTO ingest_run (merchant_id, started_at, finished_at, status, offers_seen,
                                 offers_created, offers_updated, price_points_written, error_text)
         VALUES ($1, now() - interval '1 hour', now() - interval '50 minutes', 'failed',
                 120, 77, 33, 44, 'boom')`,
        [id],
      );
    }
    const usage = await client.query(
      `INSERT INTO api_usage (operation, units, cost_micros, cache_hit)
       VALUES ('visual_search', 300, 0, false) RETURNING id`,
    );
    usageIds.push(Number(usage.rows[0].id));
    await client.query(
      `INSERT INTO admin_audit_event (actor_user_id, actor_role, action, target_type, target_id, reason)
       VALUES ($1, 'admin', 'merchant.deactivate', 'merchant', $2, $3)`,
      [userIds[1], String(merchantIds[1]), `${TAG} gerekce`],
    );
  });
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [userIds]);
    await client.query(
      "DELETE FROM admin_audit_event WHERE target_type = 'app_user' AND target_id = ANY($1::text[])",
      [userIds.map(String)],
    );
    await client.query("DELETE FROM api_usage WHERE id = ANY($1)", [usageIds]);
    await client.query("DELETE FROM ingest_run WHERE merchant_id = ANY($1)", [merchantIds]);
    await client.query("DELETE FROM merchant WHERE id = ANY($1)", [merchantIds]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [userIds]);
  });
  await ownerPool?.end();
});

describe("genel bakış", () => {
  it("moderatör: kartlar aynı, bağlantı yalnızca açabildiği sayfalara", async () => {
    state.token = tokens.moderator;
    const page = await html(dashboard());
    // Görünürlük değişmedi: maliyet ve yeni kullanıcı kartları moderatöre de görünür.
    expect(page).toContain("Model maliyeti (24 saat)");
    expect(page).toContain("Yeni kullanıcı (7 gün)");
    expect(page).toContain('href="/yonetim/eslestirme"');
    expect(page).toContain('href="/yonetim/magazalar?durum=aktif"');
    // Yalnızca yöneticinin açabildiği sayfalara bağlantı yok.
    expect(page).not.toContain('href="/yonetim/islemler#maliyet"');
    expect(page).not.toContain('href="/yonetim/kullanicilar"');
    expect(page).not.toContain("/yonetim/islemler#boru-hatti");
  });

  it("karar 0055: şimdi dikkat isteyenler — moderatör kendi görebildiğini, bağlantısız işletim", async () => {
    state.token = tokens.moderator;
    const page = await html(dashboard());
    expect(page).toContain("Şimdi dikkat isteyenler");
    expect(page).not.toContain('href="/yonetim/islemler"');
    expect(page).not.toContain("Fiyat partition");
    state.token = tokens.admin;
    const admin = await html(dashboard());
    expect(admin).toContain("Şimdi dikkat isteyenler");
    expect(admin).toContain('href="/yonetim/islemler"');
  });

  it("yönetici: maliyet ve kullanıcı kartları ilgili sayfaya gider", async () => {
    state.token = tokens.admin;
    const page = await html(dashboard());
    expect(page).toContain('href="/yonetim/islemler#maliyet"');
    expect(page).toContain('href="/yonetim/kullanicilar"');
    expect(page).toContain('href="/yonetim/ingest?durum=failed"');
  });

  it("fiyatlanmamış çağrı varken maliyet asla tek başına 0,00 TL görünmez", async () => {
    state.token = tokens.admin;
    const page = await html(dashboard());
    expect(page).toContain("fiyatlanmadı (oran, kur ya da kullanım bilgisi yok)");
    expect(page).toMatch(/Hesaplanmadı|en az /);
  });

  it("dikkat listesi: aktif bozuk mağaza var, pasif mağaza yok, mağaza sayfasına bağlı", async () => {
    state.token = tokens.moderator;
    const page = await html(dashboard());
    expect(page).toContain(`href="/yonetim/magazalar/${TAG}-broken"`);
    expect(page).toContain("Son koşu başarısız");
    expect(page).not.toContain(`${TAG} off`);
  });
});

describe("veri toplama koşuları", () => {
  it("başarısız koşunun geri alınan yazımları gerçek yazım gibi gösterilmez", async () => {
    state.token = tokens.admin;
    const page = await html(ingest("failed"));
    expect(page).toContain("geri alındı (kalıcı yazım yok)");
    expect(page).not.toContain("77 / 33");
    // Görülen kayıt sayısı gerçektir ve kalır.
    expect(page).toContain("120");
  });
});

describe("işletim", () => {
  it("yönetici boru hattı aşamalarını ve elle çalışan iş etiketini görür; 'gece' yok", async () => {
    state.token = tokens.admin;
    const page = await html(operations());
    // Karar 0055: iş koşusu varsa "son çalıştı", yoksa "son kanıt".
    expect(page).toContain("Veri boru hattı");
    expect(page).toContain("Son çalıştı / son kanıt");
    for (const label of ["Veri toplama", "Eşleştirme", "Fiyat özeti", "Benzerlik kenarları"]) {
      expect(page).toContain(label);
    }
    expect(page).toContain("python -m similarity --prices");
    expect(page).toContain("Fiyat istatistiği (elle çalışan iş)");
    expect(page).not.toContain("Fiyat istatistiği (gece)");
  });

  it("moderatör işletim sayfasını göremez (sınır değişmedi)", async () => {
    state.token = tokens.moderator;
    expect(await outcome(operations)).toBe("404");
    expect(await outcome(() => jobRuns())).toBe("404");
  });

  it("karar 0055: durum bulguları, iş koşuları ve koşu geçmişi", async () => {
    state.token = tokens.admin;
    const page = await html(operations());
    expect(page).toContain("Sistem sağlığı");
    // Aktif mağazanın son koşusu başarısız: bulgu ve veri toplama bağlantısı.
    expect(page).toContain("son toplama koşusu başarısız");
    expect(page).toContain('href="/yonetim/ingest?durum=failed"');
    expect(page).toContain("Ne yapmalı:");
    expect(page).toContain("İş koşuları");
    expect(page).toContain("Günlük temizlik (giriş, arama hakkı, saklama)");
    expect(page).not.toContain("KRİTİK");
    const history = await html(jobRuns({ is: "cleanup_auth", durum: "nope" }));
    expect(history).toContain("İş koşuları");
  });
});

describe("denetim kaydı", () => {
  it("gerekçe görünür; hedef mağaza sayfasına bağlı; aktöre göre süzülür", async () => {
    state.token = tokens.admin;
    const page = await html(audit({ kisi: String(userIds[1]) }));
    expect(page).toContain("Gerekçe");
    expect(page).toContain(`${TAG} gerekce`);
    expect(page).toContain(`href="/yonetim/magazalar/${TAG}-off"`);
    expect(page).toContain(`Yalnızca hesap #${userIds[1]} tarafından yapılanlar.`);
  });

  it("geçersiz filtre değerleri yok sayılır", async () => {
    state.token = tokens.admin;
    const page = await html(audit({ hedef: "bilinmeyen", hedefId: "<script>", kisi: "-3" }));
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("Yalnızca hesap #");
  });

  it("moderatör denetim kaydını göremez (sınır değişmedi)", async () => {
    state.token = tokens.moderator;
    expect(await outcome(() => audit({}))).toBe("404");
  });
});
