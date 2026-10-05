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
