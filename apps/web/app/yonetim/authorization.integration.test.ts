/**
 * Yetki matrisi (docs/decisions/0039): her `/yonetim` sayfası ve server
 * action'ı, arayüz atlanarak doğrudan çağrılır. Beklenen:
 *
 * - anonim / süresi geçmiş oturum → `/giris`'e yönlendirme
 * - user, creator → 404
 * - moderator → kendi yetenekleri; yönetici ekranları ve mutasyonları 404
 * - admin → hepsi
 *
 * Reddedilen mutasyonda veritabanı DEĞİŞMEZ ve denetim kaydı yazılmaz.
 * Yalnızca yerel veritabanında çalışır (uzak adres görülürse durur).
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
  }),
  // P3: yönetim kapısı yeniden giriş dönüş yolunu proxy başlığından okur.
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
  usePathname: () => "/yonetim",
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

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

/** Fixture kurulumu için sahip rol; `@arilla/db` havuzu (web `pg`'ye doğrudan bağımlı değil). */
async function owner<T>(fn: (client: OwnerClient) => Promise<T>): Promise<T> {
  ownerPool ??= createDatabase(assertLocal("DATABASE_URL_OWNER")).$client;
  return fn(ownerPool);
}

type Outcome = "ok" | "login" | "404";

async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return "ok";
  } catch (error) {
    // P3: anonim/süresi geçmiş yönetim isteği ayrı yönetim girişine gider.
    if (error instanceof RedirectSignal && error.to.startsWith("/yonetim/giris")) return "login";
    if (error instanceof NotFoundSignal) return "404";
    throw error;
  }
}

const suffix = Date.now();
const tokens: Record<string, string> = {};
const userIds: number[] = [];
let merchantId = 0;
const merchantSlug = `authz-merchant-${suffix}`;
let productId = 0;
let subjectPublicId = "";
let formId = 0;
let campaignPublicId = "";
let feedbackMessageId = 0;
/** Var olmayan kampanya: gönderim/iptal yolları hiçbir şeye dokunmadan döner. */
const missingCampaign = "00000000-0000-4000-8000-000000000000";

const sp = <T extends object>(value: T) => ({ searchParams: Promise.resolve(value) });

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    for (const role of ["user", "creator", "moderator", "admin", "expired"] as const) {
      const dbRole = role === "expired" ? "admin" : role;
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id, public_id",
        [`authz-${role}-${suffix}@test.local`, dbRole],
      );
      const id = Number(res.rows[0].id);
      userIds.push(id);
      if (role === "user") subjectPublicId = res.rows[0].public_id;
      const raw = generateRawToken();
      tokens[role] = raw;
      await client.query(
        `INSERT INTO session (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
        [id, hashToken(raw), role === "expired" ? "-1" : "24"],
      );
    }
    const merchant = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type, is_active)
       VALUES ($1, 'Authz Merchant', $2, 'xml_feed', TRUE) RETURNING id`,
      [merchantSlug, `authz-${suffix}.test`],
    );
    merchantId = Number(merchant.rows[0].id);
    const product = await client.query(
      "INSERT INTO product (slug, title) VALUES ($1, 'Authz Ürün') RETURNING id",
      [`authz-urun-${suffix}`],
    );
    productId = Number(product.rows[0].id);
    const form = await client.query(
      "INSERT INTO form (slug, title) VALUES ($1, 'Authz Form') RETURNING id",
      [`authz-form-${suffix}`],
    );
    formId = Number(form.rows[0].id);
    const campaign = await client.query(
      `INSERT INTO marketing_campaign (title, subject, body)
       VALUES ($1, 'Authz konu', 'Authz gövde') RETURNING public_id`,
      [`authz-kampanya-${suffix}`],
    );
    campaignPublicId = String(campaign.rows[0].public_id);
    // Karar 0079: oy ayrıntısı sayfası için sohbet + yanıt + olumsuz oy. Sohbet,
    // test hesabı silinince CASCADE ile gider.
    const conversation = await client.query(
      "INSERT INTO conversation (user_id, title) VALUES ($1, 'Authz sohbet') RETURNING id",
      [userIds[0]],
    );
    const message = await client.query(
      `INSERT INTO chat_message (conversation_id, seq, role, kind, content)
       VALUES ($1, 1, 'assistant', 'notice', 'Authz yanıt') RETURNING id`,
      [conversation.rows[0].id],
    );
    feedbackMessageId = Number(message.rows[0].id);
    await client.query(
      `INSERT INTO chat_result_feedback (message_id, conversation_id, helpful)
       VALUES ($1, $2, FALSE)`,
      [feedbackMessageId, conversation.rows[0].id],
    );
  });
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [userIds]);
    // 0039 tetikleyicisinin aktörsüz rol satırları (yetkili test hesapları açılırken).
    await client.query(
      "DELETE FROM admin_audit_event WHERE target_type = 'app_user' AND target_id = ANY($1::text[])",
      [userIds.map(String)],
    );
    await client.query("DELETE FROM lexicon WHERE surface LIKE $1", [`authz-${suffix}%`]);
    await client.query("DELETE FROM form WHERE id = $1", [formId]);
    await client.query("DELETE FROM marketing_campaign WHERE public_id = $1", [campaignPublicId]);
    await client.query("DELETE FROM product WHERE id = $1", [productId]);
    await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [userIds]);
  });
  await ownerPool?.end();
});

const PAGES: { name: string; admin: boolean; call: () => Promise<unknown> }[] = [
  { name: "/yonetim", admin: false, call: async () => (await import("./page.tsx")).default() },
  {
    name: "/yonetim/eslestirme",
    admin: false,
    call: async () => (await import("./eslestirme/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/eslestirme/gecmis",
    admin: false,
    call: async () => (await import("./eslestirme/gecmis/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/sozluk",
    admin: false,
    call: async () => (await import("./sozluk/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/magazalar",
    admin: false,
    call: async () => (await import("./magazalar/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/magazalar/[slug]",
    admin: false,
    call: async () =>
      (await import("./magazalar/[slug]/page.tsx")).default({
        params: Promise.resolve({ slug: merchantSlug }),
        searchParams: Promise.resolve({}),
      }),
  },
  {
    name: "/yonetim/ingest",
    admin: false,
    call: async () => (await import("./ingest/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/arama/link",
    admin: false,
    call: async () => (await import("./arama/link/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/arama/gorsel",
    admin: false,
    call: async () => (await import("./arama/gorsel/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/arama/tani",
    admin: false,
    call: async () => (await import("./arama/tani/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/katalog/urunler",
    admin: false,
    call: async () => (await import("./katalog/urunler/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/katalog/urunler/[id]",
    admin: false,
    call: async () =>
      (await import("./katalog/urunler/[id]/page.tsx")).default({
        params: Promise.resolve({ id: String(productId) }),
      }),
  },
  {
    name: "/yonetim/katalog/teklifler",
    admin: false,
    call: async () => (await import("./katalog/teklifler/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/katalog/kalite",
    admin: false,
    call: async () => (await import("./katalog/kalite/page.tsx")).default(),
  },
  {
    name: "/yonetim/seo",
    admin: false,
    call: async () => (await import("./seo/page.tsx")).default(),
  },
  {
    name: "/yonetim/denetim",
    admin: true,
    call: async () => (await import("./denetim/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/islemler",
    admin: true,
    call: async () => (await import("./islemler/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/islemler/isler",
    admin: true,
    call: async () => (await import("./islemler/isler/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/kullanicilar",
    admin: true,
    call: async () => (await import("./kullanicilar/page.tsx")).default(),
  },
  {
    name: "/yonetim/mesajlar",
    admin: true,
    call: async () => (await import("./mesajlar/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/kampanyalar",
    admin: true,
    call: async () => (await import("./kampanyalar/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/kullanicilar/[publicId]",
    admin: true,
    call: async () =>
      (await import("./kullanicilar/[publicId]/page.tsx")).default({
        params: Promise.resolve({ publicId: subjectPublicId }),
      }),
  },
  {
    name: "/yonetim/kampanyalar/[publicId]",
    admin: true,
    call: async () =>
      (await import("./kampanyalar/[publicId]/page.tsx")).default({
        params: Promise.resolve({ publicId: campaignPublicId }),
      }),
  },
  {
    name: "/yonetim/ai-geri-bildirim",
    admin: true,
    call: async () => (await import("./ai-geri-bildirim/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/ai-geri-bildirim/[messageId]",
    admin: true,
    call: async () =>
      (await import("./ai-geri-bildirim/[messageId]/page.tsx")).default({
        params: Promise.resolve({ messageId: String(feedbackMessageId) }),
      }),
  },
  // Karar 0085: analitik merkez ekranları (yalnızca yönetici).
  {
    name: "/yonetim/ai",
    admin: true,
    call: async () => (await import("./ai/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/yolculuk",
    admin: true,
    call: async () => (await import("./yolculuk/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/affiliate",
    admin: true,
    call: async () => (await import("./affiliate/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/erken-erisim",
    admin: true,
    call: async () => (await import("./erken-erisim/page.tsx")).default(sp({})),
  },
  // Karar 0086: yönetim özellikleri (yalnızca yönetici).
  {
    name: "/yonetim/trendler",
    admin: true,
    call: async () => (await import("./trendler/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/ayarlar",
    admin: true,
    call: async () => (await import("./ayarlar/page.tsx")).default(),
  },
  // Karar 0087: GA4 trafik (yalnızca yönetici).
  {
    name: "/yonetim/trafik",
    admin: true,
    call: async () => (await import("./trafik/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/formlar",
    admin: true,
    call: async () => (await import("./formlar/page.tsx")).default(sp({})),
  },
  {
    name: "/yonetim/formlar/yeni",
    admin: true,
    call: async () => (await import("./formlar/yeni/page.tsx")).default(),
  },
  {
    name: "/yonetim/formlar/[id]",
    admin: true,
    call: async () =>
      (await import("./formlar/[id]/page.tsx")).default({
        params: Promise.resolve({ id: String(formId) }),
      }),
  },
  {
    name: "/yonetim/formlar/[id]/sonuclar",
    admin: true,
    call: async () =>
      (await import("./formlar/[id]/sonuclar/page.tsx")).default({
        params: Promise.resolve({ id: String(formId) }),
      }),
  },
];

function expected(role: string, adminOnly: boolean): Outcome {
  if (role === "anonymous" || role === "expired") return "login";
  if (role === "user" || role === "creator") return "404";
  if (role === "moderator") return adminOnly ? "404" : "ok";
  return "ok";
}

const ROLES = ["anonymous", "expired", "user", "creator", "moderator", "admin"] as const;

describe("yönetim sayfaları - yetki matrisi", () => {
  for (const role of ROLES) {
    it(`${role}`, async () => {
      state.token = role === "anonymous" ? undefined : tokens[role];
      const results: Record<string, Outcome> = {};
      for (const page of PAGES) results[page.name] = await outcome(page.call);
      const want = Object.fromEntries(PAGES.map((p) => [p.name, expected(role, p.admin)]));
      expect(results).toEqual(want);
    });
  }

  it("layout: kabuk da aynı kapıdan geçer", async () => {
    const layout = (await import("./layout.tsx")).default;
    state.token = tokens.user;
    expect(await outcome(() => layout({ children: null }))).toBe("404");
    state.token = undefined;
    expect(await outcome(() => layout({ children: null }))).toBe("login");
    state.token = tokens.moderator;
    expect(await outcome(() => layout({ children: null }))).toBe("ok");
  });
});

describe("server action'lar - arayüz atlanarak doğrudan çağrı", () => {
  const merchantActive = () =>
    owner(async (client) => {
      const res = await client.query("SELECT is_active FROM merchant WHERE id = $1", [merchantId]);
      return res.rows[0].is_active as boolean;
    });
  // Mutasyon denetimi; reddedilen erişim olayları (karar 0050) ayrıca sayılır.
  const auditCount = () =>
    owner(async (client) => {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM admin_audit_event
          WHERE actor_user_id = ANY($1) AND action NOT LIKE 'security.%'`,
        [userIds],
      );
      return res.rows[0].n as number;
    });
  const deniedRoles = (capability: string) =>
    owner(async (client) => {
      const res = await client.query(
        `SELECT DISTINCT actor_role FROM admin_audit_event
          WHERE actor_user_id = ANY($1) AND action = 'security.access_denied' AND target_id = $2
          ORDER BY actor_role`,
        [userIds, capability],
      );
      return res.rows.map((row) => row.actor_role as string);
    });

  it("mağaza aç/kapat: yalnızca yönetici; diğerlerinde veri ve denetim değişmez", async () => {
    const { setMerchantActiveAction } = await import("./magazalar/actions.ts");
    const input = {
      merchantId,
      active: false,
      reason: "yetki matrisi denemesi",
      confirmSlug: merchantSlug,
    };
    const before = await auditCount();
    for (const role of ["anonymous", "expired", "user", "creator", "moderator"] as const) {
      state.token = role === "anonymous" ? undefined : tokens[role];
      expect(await outcome(() => setMerchantActiveAction(input))).toBe(
        role === "anonymous" || role === "expired" ? "login" : "404",
      );
    }
    expect(await merchantActive()).toBe(true);
    expect(await auditCount()).toBe(before);
    // Girişli ama yetkisiz denemeler denetimde görünür; anonim ve süresi dolmuş görünmez.
    expect(await deniedRoles("merchant.manage")).toEqual(["creator", "moderator", "user"]);

    state.token = tokens.admin;
    expect(await setMerchantActiveAction(input)).toEqual({ ok: true, changed: true });
    expect(await merchantActive()).toBe(false);
    expect(await auditCount()).toBe(before + 1);
  });

  it("taze olmayan yönetici oturumu mağazayı değiştiremez", async () => {
    const { setMerchantActiveAction } = await import("./magazalar/actions.ts");
    await owner((client) =>
      client.query(
        // 12 saatlik yönetim oturumu içinde ama 1 saatlik taze giriş penceresi dışında.
        "UPDATE session SET created_at = now() - interval '2 hours' WHERE token_hash = $1",
        [hashToken(tokens.admin ?? "")],
      ),
    );
    state.token = tokens.admin;
    const result = await setMerchantActiveAction({
      merchantId,
      active: true,
      reason: "eski oturumla deneme",
      confirmSlug: merchantSlug,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reauthHref).toBe("/yonetim/giris?neden=yeniden");
    expect(await merchantActive()).toBe(false);
    await owner((client) =>
      client.query("UPDATE session SET created_at = now() WHERE token_hash = $1", [
        hashToken(tokens.admin ?? ""),
      ]),
    );
  });

  it("kullanıcı arama: yalnızca yönetici", async () => {
    const { searchUsersAction } = await import("./kullanicilar/actions.ts");
    const form = new FormData();
    form.set("q", `authz-user-${suffix}`);
    for (const role of ["user", "creator", "moderator"] as const) {
      state.token = tokens[role];
      expect(await outcome(() => searchUsersAction({ status: "idle" }, form))).toBe("404");
    }
    state.token = undefined;
    expect(await outcome(() => searchUsersAction({ status: "idle" }, form))).toBe("login");
    state.token = tokens.admin;
    const result = await searchUsersAction({ status: "idle" }, form);
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.rows.map((row) => row.publicId)).toContain(
      subjectPublicId,
    );
  });

  it("sözlük ve eşleştirme: user/creator reddedilir, moderator geçer", async () => {
    const { saveLexiconEntryAction, deleteLexiconEntryAction } = await import(
      "./sozluk/actions.ts"
    );
    const { approveMatchAction, rejectMatchAction } = await import("./eslestirme/actions.ts");
    const entry = {
      kind: "color" as const,
      surface: `authz-${suffix}`,
      normalized: "authz",
      weight: 1,
    };
    for (const role of ["user", "creator"] as const) {
      state.token = tokens[role];
      expect(await outcome(() => saveLexiconEntryAction(entry))).toBe("404");
      expect(await outcome(() => deleteLexiconEntryAction(1))).toBe("404");
      expect(await outcome(() => approveMatchAction(1))).toBe("404");
      expect(await outcome(() => rejectMatchAction(1, "other"))).toBe("404");
    }
    state.token = undefined;
    expect(await outcome(() => saveLexiconEntryAction(entry))).toBe("login");

    state.token = tokens.moderator;
    expect(await saveLexiconEntryAction(entry)).toEqual({ ok: true });
    expect(await saveLexiconEntryAction({ ...entry, weight: Number.NaN })).toMatchObject({
      ok: false,
    });
    expect(await approveMatchAction(-5)).toEqual({ found: false });
    expect(await rejectMatchAction(999_999_999, "uydurma-neden")).toEqual({ found: false });
  });

  it("oturumları kapatma: yalnızca taze girişli yönetici; hedefin bütün oturumları gider (karar 0050)", async () => {
    const { revokeUserSessionsAction } = await import("./kullanicilar/actions.ts");
    const victim = await owner(async (client) => {
      const res = await client.query(
        "INSERT INTO app_user (email) VALUES ($1) RETURNING id, public_id",
        [`authz-victim-${suffix}@test.local`],
      );
      const id = Number(res.rows[0].id);
      userIds.push(id);
      for (const n of [1, 2]) {
        await client.query(
          "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
          [id, hashToken(`authz-victim-${suffix}-${n}`)],
        );
      }
      return { id, publicId: String(res.rows[0].public_id) };
    });
    const victimSessions = () =>
      owner(async (client) => {
        const res = await client.query(
          "SELECT count(*)::int AS n FROM session WHERE user_id = $1",
          [victim.id],
        );
        return res.rows[0].n as number;
      });
    const input = { publicId: victim.publicId, reason: "ele gecirilmis hesap suphesi" };

    for (const role of ["user", "creator", "moderator"] as const) {
      state.token = tokens[role];
      expect(await outcome(() => revokeUserSessionsAction(input))).toBe("404");
    }
    state.token = undefined;
    expect(await outcome(() => revokeUserSessionsAction(input))).toBe("login");
    expect(await victimSessions()).toBe(2);

    // Taze olmayan yönetici: işlem yapılmaz, yeniden giriş bağlantısı döner.
    await owner((client) =>
      client.query(
        "UPDATE session SET created_at = now() - interval '2 hours' WHERE token_hash = $1",
        [hashToken(tokens.admin ?? "")],
      ),
    );
    state.token = tokens.admin;
    const stale = await revokeUserSessionsAction(input);
    expect(stale.ok).toBe(false);
    expect(stale.ok ? null : stale.reauthHref).toContain("neden=yeniden");
    expect(await victimSessions()).toBe(2);
    await owner((client) =>
      client.query("UPDATE session SET created_at = now() WHERE token_hash = $1", [
        hashToken(tokens.admin ?? ""),
      ]),
    );

    expect(await revokeUserSessionsAction({ ...input, reason: "x" })).toMatchObject({ ok: false });
    expect(await revokeUserSessionsAction(input)).toEqual({ ok: true, count: 2 });
    expect(await victimSessions()).toBe(0);
    const audit = await owner(async (client) => {
      const res = await client.query(
        `SELECT reason, after FROM admin_audit_event
          WHERE action = 'sessions.revoke_all' AND target_id = $1`,
        [String(victim.id)],
      );
      return res.rows;
    });
    expect(audit).toEqual([
      {
        reason: "ele gecirilmis hesap suphesi",
        after: { count: 2, scope: "admin", outcome: "applied" },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Karar 0082 (Faz A0): matris eksiksizdir. Her `page.tsx` PAGES'te, her dışa
// açık server action ACTIONS'ta olmak zorunda; yeni sayfa ya da action
// matrise eklenmeden bu testler kırılır.
// ---------------------------------------------------------------------------

const yonetimDir = dirname(fileURLToPath(import.meta.url));

function filesNamed(dir: string, fileName: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesNamed(path, fileName));
    else if (name === fileName) out.push(path);
  }
  return out;
}

/** `formlar/[id]/sonuclar/page.tsx` → `/yonetim/formlar/[id]/sonuclar`. */
function routeOf(pageFile: string): string {
  const rel = relative(yonetimDir, dirname(pageFile)).split(sep).join("/");
  return rel === "" ? "/yonetim" : `/yonetim/${rel}`;
}

type ActionOutcome = Outcome | "redirect";

/** Action için: yönetim girişi dışındaki yönlendirme (ör. form sonrası) kapıdan geçmiştir. */
async function actionOutcome(fn: () => Promise<unknown>): Promise<ActionOutcome> {
  try {
    return await outcome(fn);
  } catch (error) {
    if (error instanceof RedirectSignal) return "redirect";
    throw error;
  }
}

interface ActionCase {
  module: string;
  name: string;
  /** Moderatör de geçer mi (yetenek moderatör haritasında). */
  moderator: boolean;
  /** Zararsız çağrı: geçerli rolde bile doğrulama/bulunamadı ile döner, veri değişmez. */
  call: () => Promise<unknown>;
}

const lexiconEntry = () => ({
  kind: "color" as const,
  surface: `authz-matrix-${suffix}`,
  normalized: "authz",
  // Geçersiz ağırlık: kapıyı geçen rolde bile yazım olmaz.
  weight: Number.NaN,
});

const ACTIONS: ActionCase[] = [
  // Karar 0086: geçersiz kimlik, kapıyı geçen rolde doğrulama hatasıyla döner.
  {
    module: "trendler",
    name: "setTrendStatusAction",
    moderator: false,
    call: async () =>
      (await import("./trendler/actions.ts")).setTrendStatusAction({
        trendId: -1,
        next: "published",
        expectedStatus: "draft",
        reason: "yetki matrisi denemesi",
      }),
  },
  {
    module: "trendler",
    name: "setTrendFeaturedAction",
    moderator: false,
    call: async () =>
      (await import("./trendler/actions.ts")).setTrendFeaturedAction({
        trendId: -1,
        featured: true,
        reason: "yetki matrisi denemesi",
      }),
  },
  {
    module: "trendler",
    name: "moveTrendAction",
    moderator: false,
    call: async () =>
      (await import("./trendler/actions.ts")).moveTrendAction({
        trendId: -1,
        direction: "up",
        reason: "yetki matrisi denemesi",
      }),
  },
  {
    module: "mesajlar",
    name: "setMessageStatusAction",
    moderator: false,
    call: async () =>
      (await import("./mesajlar/actions.ts")).setMessageStatusAction({
        messageId: -1,
        next: "reviewing",
        expectedStatus: "new",
      }),
  },
  {
    module: "mesajlar",
    name: "setMessagePriorityAction",
    moderator: false,
    call: async () =>
      (await import("./mesajlar/actions.ts")).setMessagePriorityAction({
        messageId: -1,
        priority: "high",
      }),
  },
  {
    module: "eslestirme",
    name: "approveMatchAction",
    moderator: true,
    call: async () => (await import("./eslestirme/actions.ts")).approveMatchAction(-5),
  },
  {
    module: "eslestirme",
    name: "rejectMatchAction",
    moderator: true,
    call: async () =>
      (await import("./eslestirme/actions.ts")).rejectMatchAction(999_999_999, "other"),
  },
  {
    module: "sozluk",
    name: "saveLexiconEntryAction",
    moderator: true,
    call: async () => (await import("./sozluk/actions.ts")).saveLexiconEntryAction(lexiconEntry()),
  },
  {
    module: "sozluk",
    name: "deleteLexiconEntryAction",
    moderator: true,
    call: async () => (await import("./sozluk/actions.ts")).deleteLexiconEntryAction(-1),
  },
  {
    module: "magazalar",
    name: "setMerchantActiveAction",
    moderator: false,
    call: async () =>
      (await import("./magazalar/actions.ts")).setMerchantActiveAction({
        merchantId,
        active: true,
        reason: "x",
        confirmSlug: "yanlis-kisa-ad",
      }),
  },
  {
    module: "kullanicilar",
    name: "searchUsersAction",
    moderator: false,
    call: async () => {
      const form = new FormData();
      form.set("q", `authz-yok-${suffix}`);
      return (await import("./kullanicilar/actions.ts")).searchUsersAction(
        { status: "idle" },
        form,
      );
    },
  },
  {
    module: "kullanicilar",
    name: "revokeUserSessionsAction",
    moderator: false,
    call: async () =>
      (await import("./kullanicilar/actions.ts")).revokeUserSessionsAction({
        publicId: subjectPublicId,
        reason: "x",
      }),
  },
  {
    module: "kullanicilar",
    name: "revealContactAction",
    moderator: false,
    call: async () =>
      (await import("./kullanicilar/actions.ts")).revealContactAction(
        subjectPublicId,
        "gecersiz-alan" as never,
      ),
  },
  {
    module: "erken-erisim",
    name: "setOffPlatformCountAction",
    moderator: false,
    call: async () => {
      const form = new FormData();
      form.set("count", "sayi-degil");
      form.set("reason", "yetki matrisi denemesi");
      return (await import("./erken-erisim/actions.ts")).setOffPlatformCountAction(form);
    },
  },
  {
    module: "formlar",
    name: "createFormAction",
    moderator: false,
    call: async () => (await import("./formlar/actions.ts")).createFormAction({}),
  },
  {
    module: "formlar",
    name: "updateFormAction",
    moderator: false,
    call: async () => (await import("./formlar/actions.ts")).updateFormAction(formId, {}, 0),
  },
  {
    module: "formlar",
    name: "setFormStatusAction",
    moderator: false,
    call: async () =>
      (await import("./formlar/actions.ts")).setFormStatusAction(formId, "gecersiz" as never),
  },
  {
    module: "kampanyalar",
    name: "createCampaignAction",
    moderator: false,
    call: async () =>
      (await import("./kampanyalar/actions.ts")).createCampaignAction({
        title: "",
        subject: "",
        body: "",
      }),
  },
  {
    module: "kampanyalar",
    name: "updateCampaignAction",
    moderator: false,
    call: async () =>
      (await import("./kampanyalar/actions.ts")).updateCampaignAction({
        publicId: campaignPublicId,
        expectedContentVersion: 1,
        title: "",
        subject: "",
        body: "",
      }),
  },
  {
    module: "kampanyalar",
    name: "sendTestAction",
    moderator: false,
    call: async () =>
      (await import("./kampanyalar/actions.ts")).sendTestAction({
        publicId: missingCampaign,
        expectedContentVersion: 1,
        recipient: "adres-degil",
      }),
  },
  {
    module: "kampanyalar",
    name: "startSendAction",
    moderator: false,
    call: async () =>
      (await import("./kampanyalar/actions.ts")).startSendAction({
        publicId: missingCampaign,
        expectedContentVersion: 1,
        confirmed: false,
      }),
  },
  {
    module: "kampanyalar",
    name: "processNextBatchAction",
    moderator: false,
    call: async () =>
      (await import("./kampanyalar/actions.ts")).processNextBatchAction(missingCampaign),
  },
  {
    module: "kampanyalar",
    name: "cancelCampaignAction",
    moderator: false,
    call: async () =>
      (await import("./kampanyalar/actions.ts")).cancelCampaignAction(missingCampaign),
  },
];

describe("matris kapsamı (karar 0082)", () => {
  it("yönetimdeki her page.tsx sayfa matrisinde", () => {
    const routes = filesNamed(yonetimDir, "page.tsx").map(routeOf).sort();
    expect(PAGES.map((page) => page.name).sort()).toEqual(routes);
  });

  it("her actions.ts'in dışa açık her fonksiyonu action matrisinde", async () => {
    const exported: string[] = [];
    for (const file of filesNamed(yonetimDir, "actions.ts")) {
      const module = relative(yonetimDir, dirname(file)).split(sep).join("/");
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === "function") exported.push(`${module}.${name}`);
      }
    }
    expect(ACTIONS.map((a) => `${a.module}.${a.name}`).sort()).toEqual(exported.sort());
  });
});

describe("server action matrisi - her action, her rol (karar 0082)", () => {
  /** Matristeki zararsız çağrılardan hiçbiri veri değiştirmemeli: önce/sonra anlık görüntü. */
  const snapshot = () =>
    owner(async (client) => {
      const res = await client.query(
        `SELECT
           (SELECT count(*) FROM form)::int AS forms,
           (SELECT row_to_json(f) FROM (SELECT status, title, updated_at FROM form WHERE id = $1) f) AS fixture_form,
           (SELECT count(*) FROM marketing_campaign)::int AS campaigns,
           (SELECT row_to_json(c) FROM (SELECT status, title, content_version FROM marketing_campaign WHERE public_id = $2) c) AS fixture_campaign,
           (SELECT count(*) FROM lexicon WHERE surface LIKE $3)::int AS lexicon,
           (SELECT row_to_json(e) FROM early_access_counter e) AS counter,
           (SELECT is_active FROM merchant WHERE id = $4) AS merchant_active,
           (SELECT count(*) FROM session WHERE user_id = ANY($5))::int AS sessions,
           (SELECT string_agg(id || ':' || status || ':' || featured || ':' || sort_order, ',' ORDER BY id) FROM trend) AS trends,
           (SELECT string_agg(id || ':' || status || ':' || coalesce(priority, '-'), ',' ORDER BY id) FROM feedback) AS feedback`,
        [formId, campaignPublicId, `authz-matrix-${suffix}%`, merchantId, userIds],
      );
      return res.rows[0];
    });
  const mutationAudits = () =>
    owner(async (client) => {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM admin_audit_event
          WHERE actor_user_id = ANY($1)
            AND action NOT LIKE 'security.%'
            AND action NOT IN ('users.search', 'users.lookup')`,
        [userIds],
      );
      return res.rows[0].n as number;
    });

  for (const action of ACTIONS) {
    it(`${action.module}.${action.name}`, async () => {
      // Önceki testler yöneticinin oturum zamanını oynatmış olabilir: taze başla.
      await owner((client) =>
        client.query(
          "UPDATE session SET created_at = now(), last_used_at = now() WHERE user_id = ANY($1)",
          [userIds],
        ),
      );
      const before = await snapshot();
      const auditsBefore = await mutationAudits();

      const results: Record<string, ActionOutcome> = {};
      for (const role of ROLES) {
        state.token = role === "anonymous" ? undefined : tokens[role];
        results[role] = await actionOutcome(action.call);
      }
      const passed = (allowed: boolean): ActionOutcome[] =>
        allowed ? ["ok", "redirect"] : ["404"];
      expect(results.anonymous).toBe("login");
      expect(results.expired).toBe("login");
      expect(results.user).toBe("404");
      expect(results.creator).toBe("404");
      expect(passed(action.moderator)).toContain(results.moderator);
      expect(passed(true)).toContain(results.admin);

      // Reddedilen ve zararsız çağrılar: veri ve mutasyon denetimi değişmez.
      expect(await snapshot()).toEqual(before);
      expect(await mutationAudits()).toBe(auditsBefore);
    });
  }
});
