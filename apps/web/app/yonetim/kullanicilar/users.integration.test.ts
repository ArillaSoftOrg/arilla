/**
 * Yönetim kullanıcı araması ve hesap ayrıntısı (salt okunur gözlem). Gerçek
 * yerel Postgres; `next/*` taklit edilir. Uzak adres görülürse durur.
 *
 * - kısmi ad/e-posta araması (Türkçe katlamalı), tam hesap kimliği, telefon
 *   uyumluluğu; çok kısa sorgu, sonuçsuz sorgu, sınırlı sonuç ve sayfa
 * - arama terimi denetim kaydına sızmaz
 * - anonim/normal kullanıcı arayamaz ve ayrıntı göremez; yönetici görür
 * - ayrıntı: erken erişim, arama hakkı (motorun kendi okuması), defter,
 *   davet özeti, rıza üç durumu, boş telefonun gizlenmesi
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// Sayfa HTML'e çevrilirken Next yönlendiricisi yok: bağlantı düz `<a>`.
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

async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (error) {
    if (error instanceof RedirectSignal && error.to.startsWith("/yonetim/giris")) return "login";
    if (error instanceof NotFoundSignal) return "404";
    throw error;
  }
}

const suffix = Date.now().toString(36);
/** Sorgularda kullanılan ve başka hiçbir satırla çakışmayan iz. */
const TAG = `kz${suffix}`;
const tokens: Record<"admin" | "user", string> = { admin: "", user: "" };
const ids: Record<string, number> = {};
const publicIds: Record<string, string> = {};
const allUserIds: number[] = [];

async function createUser(
  key: string,
  values: { email?: string | null; displayName?: string | null; role?: string },
): Promise<number> {
  return owner(async (client) => {
    const res = await client.query(
      "INSERT INTO app_user (email, display_name, role) VALUES ($1, $2, $3) RETURNING id, public_id",
      [values.email ?? null, values.displayName ?? null, values.role ?? "user"],
    );
    const id = Number(res.rows[0].id);
    ids[key] = id;
    publicIds[key] = res.rows[0].public_id;
    allUserIds.push(id);
    return id;
  });
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  for (const role of ["admin", "user"] as const) {
    const id = await createUser(role, { email: `${TAG}-${role}@test.local`, role });
    tokens[role] = generateRawToken();
    await owner((client) =>
      client.query(
        "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [id, hashToken(tokens[role])],
      ),
    );
  }

  // Dolu hesap: Türkçe ad, gmail-benzeri e-posta, erken erişim, hak ve davet.
  const rich = await createUser("rich", {
    email: `ayse.isik.${TAG}@gmail-test.local`,
    displayName: `Ayşe IŞIK ${TAG}`,
  });
  // Boş hesap: adsız, kayıtsız.
  await createUser("bare", { email: `bos.${TAG}@test.local` });
  // Davet edilen (rich tarafından).
  const invitee = await createUser("invitee", { email: `davetli.${TAG}@test.local` });
  // Telefon kimliği (bugün aktif giriş yolu değil; uyumluluk).
  const phoneUser = await createUser("phone", { email: null, displayName: null });
  // Sınır testi: aynı izi taşıyan 22 hesap.
  for (let i = 0; i < 22; i++) {
    await createUser(`bulk${i}`, { email: `toplu${i}.${TAG}@test.local` });
  }

  await owner(async (client) => {
    await client.query("INSERT INTO early_access (user_id) VALUES ($1)", [rich]);
    await client.query(
      `INSERT INTO user_identity (user_id, provider, provider_subject, email_verified)
       VALUES ($1, 'phone', $2, false)`,
      [phoneUser, `+90555${String(Date.now()).slice(-7)}`],
    );
    await client.query("UPDATE app_user SET referral_code = $1 WHERE id = $2", [
      `AB${String(Date.now()).slice(-6).replace(/[01]/g, "2")}`,
      rich,
    ]);
    const referral = await client.query(
      `INSERT INTO referral (inviter_user_id, invitee_user_id, status, qualified_at)
       VALUES ($1, $2, 'qualified', now()) RETURNING id`,
      [rich, invitee],
    );
    const referralId = Number(referral.rows[0].id);
    const today = "(now() AT TIME ZONE 'Europe/Istanbul')::date";
    await client.query(
      `INSERT INTO ai_quota_day (user_id, day, daily_limit, used) VALUES ($1, ${today}, 10, 1)`,
      [rich],
    );
    await client.query("INSERT INTO bonus_account (user_id, balance) VALUES ($1, 12)", [rich]);
    const settled = await client.query(
      `INSERT INTO ai_search_charge
         (user_id, operation, request_key, cost, day, from_daily, from_bonus, state, finalized_at)
       VALUES ($1, 'visual_search', $2, 1, ${today}, 0, 1, 'settled', now()) RETURNING id`,
      [rich, `req-${TAG}-1`],
    );
    await client.query(
      `INSERT INTO ai_search_charge
         (user_id, operation, request_key, cost, day, from_daily, from_bonus, state, refund_reason, finalized_at)
       VALUES ($1, 'link_search', $2, 1, ${today}, 1, 0, 'refunded', 'provider_error', now())`,
      [rich, `req-${TAG}-2`],
    );
    const ledger = [
      [10, 10, "referral_inviter", `referral:${referralId}:inviter`, null, referralId],
      [3, 13, "feedback_first", `feedback_first:${rich}`, null, null],
      [-1, 12, "search_charge", `charge:${settled.rows[0].id}`, settled.rows[0].id, null],
    ] as const;
    for (const [delta, after, reason, key, chargeId, refId] of ledger) {
      await client.query(
        `INSERT INTO bonus_ledger
           (user_id, delta, requested, balance_after, reason, idempotency_key, charge_id, referral_id)
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7)`,
        [rich, delta, after, reason, key, chargeId, refId],
      );
    }
    await client.query(
      "INSERT INTO user_consent (user_id, kind, granted) VALUES ($1, 'marketing_email', true), ($1, 'personalization', false)",
      [rich],
    );
  });
});

beforeEach(() => {
  state.token = tokens.admin;
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [allUserIds]);
    // Defter ve harcama CASCADE ile gider (append-only REVOKE sahip rolü bağlamaz).
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [allUserIds]);
  });
  await ownerPool?.end();
});

async function search(q: string, page = 1) {
  const { searchUsersAction } = await import("./actions.ts");
  const form = new FormData();
  form.set("q", q);
  form.set("sayfa", String(page));
  return searchUsersAction({ status: "idle" }, form);
}

async function detailHtml(key: string, sekme?: string): Promise<string> {
  const { default: Page } = await import("./[publicId]/page.tsx");
  const element = (await Page({
    params: Promise.resolve({ publicId: publicIds[key] ?? "" }),
    searchParams: Promise.resolve(sekme ? { sekme } : {}),
  })) as ReactElement | undefined;
  return renderToStaticMarkup(element as ReactElement);
}

/** Görünen metin; öznitelikler değil. */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("kullanıcı araması", () => {
  it("e-postanın bir kısmıyla bulur; ad ve maskeli e-posta döner", async () => {
    const result = await search(`isik.${TAG}`);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rows.map((row) => row.publicId)).toEqual([publicIds.rich]);
    const [row] = result.rows;
    expect(row?.displayName).toBe(`Ayşe IŞIK ${TAG}`);
    expect(row?.emailMasked).toMatch(/^a\*\*\*@gmail-test\.local$/);
    expect(row?.earlyAccess?.status).toBe("pending");
  });

  it("adda Türkçe karakter ve büyük/küçük harf duyarsız (ayse ışık ~ Ayşe IŞIK)", async () => {
    for (const q of ["ayse isik", "AYŞE", "ışık"]) {
      const result = await search(`${q}`);
      expect(result.status, q).toBe("ok");
      if (result.status !== "ok") continue;
      expect(
        result.rows.map((row) => row.publicId),
        q,
      ).toContain(publicIds.rich);
    }
  });

  it("tam hesap kimliği kısa sorgu kuralından muaf, tam eşleşir", async () => {
    const result = await search((publicIds.bare ?? "").toUpperCase());
    expect(result.status === "ok" && result.rows.map((row) => row.publicId)).toEqual([
      publicIds.bare,
    ]);
  });

  it("telefon (uyumluluk): tam E.164 eşleşir ve maskeli döner", async () => {
    const phone = await owner(async (client) => {
      const res = await client.query(
        "SELECT provider_subject FROM user_identity WHERE user_id = $1 AND provider = 'phone'",
        [ids.phone],
      );
      return String(res.rows[0].provider_subject);
    });
    const result = await search(phone);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rows.map((row) => row.publicId)).toEqual([publicIds.phone]);
    expect(result.rows[0]?.phoneMasked).toBe(`+90 ••• ••• ••${phone.slice(-2)}`);
    expect(JSON.stringify(result)).not.toContain(phone);
  });

  it("sonuçsuz sorgu boş liste döner", async () => {
    const result = await search(`yok-boyle-${TAG}`);
    expect(result).toEqual({ status: "ok", rows: [], page: 1, hasNext: false });
  });

  it("çok kısa sorgu reddedilir; boş sorgu reddedilir", async () => {
    expect(await search("a")).toEqual({ status: "error", message: "En az 2 karakter yaz." });
    expect((await search("   ")).status).toBe("error");
  });

  it("LIKE özel karakterleri düz metin aranır (% her şeyi eşleştirmez)", async () => {
    const result = await search("%%");
    expect(result.status === "ok" && result.rows.length).toBe(0);
  });

  it("sonuçlar sayfa başına 20 ile sınırlı ve sayfalanır", async () => {
    const first = await search(`toplu`);
    expect(first.status).toBe("ok");
    const scoped = await search(`.${TAG}@test.local`);
    expect(scoped.status).toBe("ok");
    if (scoped.status !== "ok") return;
    expect(scoped.rows).toHaveLength(20);
    expect(scoped.hasNext).toBe(true);
    const second = await search(`.${TAG}@test.local`, 2);
    expect(second.status === "ok" && second.rows.length).toBeGreaterThan(0);
    expect(second.status === "ok" && second.hasNext).toBe(false);
  });

  it("aranan değer denetim kaydına yazılmaz; yöntem ve sonuç sayısı yazılır", async () => {
    await search(`ayse.isik.${TAG}`);
    const rows = await owner(async (client) => {
      const res = await client.query(
        `SELECT action, target_id, before::text b, after::text a, reason
           FROM admin_audit_event WHERE actor_user_id = $1 AND action = 'users.search'`,
        [ids.admin],
      );
      return res.rows as { b: string | null; a: string | null; reason: string | null }[];
    });
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(TAG);
    expect(dump).not.toContain("ayse");
    expect(dump).not.toContain("+90");
    expect(rows.at(-1)?.a).toContain('"method": "text"');
  });
});

describe("yetki", () => {
  it("anonim ve normal kullanıcı arayamaz", async () => {
    state.token = undefined;
    expect(await outcome(() => search(`isik.${TAG}`))).toBe("login");
    state.token = tokens.user;
    expect(await outcome(() => search(`isik.${TAG}`))).toBe("404");
  });

  it("normal kullanıcı başka bir hesabın ayrıntısını kimliğini bilse de göremez", async () => {
    state.token = tokens.user;
    expect(await outcome(() => detailHtml("rich"))).toBe("404");
    state.token = undefined;
    expect(await outcome(() => detailHtml("rich"))).toBe("login");
    state.token = tokens.admin;
    expect(await outcome(() => detailHtml("rich"))).toBe("ok");
  });

  it("liste sayfası: yönetici açar, normal kullanıcı 404", async () => {
    const { default: UsersPage } = await import("./page.tsx");
    expect(await outcome(UsersPage)).toBe("ok");
    state.token = tokens.user;
    expect(await outcome(UsersPage)).toBe("404");
  });
});

describe("hesap ayrıntısı", () => {
  it("dolu hesap: ad, erken erişim, hak durumu, defter, davet, rıza", async () => {
    const html = text(await detailHtml("rich"));
    expect(html).toContain(`Ayşe IŞIK ${TAG}`);
    // Erken erişim
    expect(html).toContain("Listede, açılış bekleniyor");
    // Hak motorunun okuması: günlük 9/10, bonus 12
    expect(html).toContain("Bugün kalan günlük hak 9 / 10");
    expect(html).toContain("Bonus bakiyesi 12");
    expect(html).toContain("Toplam kazanılan bonus: 13");
    expect(html).toContain("Kullanılan arama 1");
    expect(html).toContain("İade edilen arama 1");
    // Son hareketler, Türkçe etiketlerle
    expect(html).toContain("Fotoğrafla arama");
    expect(html).toContain("İade edildi · Sağlayıcı hatası");
    expect(html).toContain("Davet ödülü (davet eden)");
    expect(html).toContain("İlk geri bildirim ödülü");
    expect(html).toContain("+10");
    expect(html).toContain("-1");
    // Davet özeti, kimlik yok
    expect(html).toContain("Geçerli davet 1");
    expect(html).toContain("Davetten kazanılan bonus 10");
    expect(html).not.toContain(`davetli.${TAG}`);
    // Telefon yok → telefon satırı yok
    expect(html).not.toContain("Telefon");
    // Ham enum değerleri görünmez
    expect(html).not.toMatch(/\b(visual_search|referral_inviter|provider_error|pending)\b/);
  });

  it("boş hesap: anlamlı boş durumlar, uydurma değer yok", async () => {
    const html = text(await detailHtml("bare"));
    expect(html).toContain("Erken erişim listesinde değil");
    expect(html).toContain("Hak hareketi yok");
    expect(html).toContain("Henüz oluşturulmadı");
    expect(html).toContain("Davetle mi geldi Hayır");
    expect(html).not.toContain("Telefon");
    expect(html).not.toContain("Creator");
  });

  it("İzinler sekmesi: kabul, ret ve kayıt yok; eski satırlar sürümsüz ama geçerli; IP yok", async () => {
    const html = text(await detailHtml("rich", "izinler"));
    expect(html).toContain("Pazarlama e-postası Kabul");
    expect(html).toContain("Kişiselleştirme Ret");
    expect(html).toContain("Gezinme geçmişi Kayıt yok");
    // 0037 öncesi satır: geçerli karar, yalnızca etiketli.
    expect(html).toContain("sürümsüz kayıt");
    expect(html).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    const bare = text(await detailHtml("bare", "izinler"));
    expect(bare).toContain("Kayıt yok");
    expect(bare).not.toContain("Kabul");
  });

  it("görüntüleme davet kodu ÜRETMEZ (salt okunur)", async () => {
    await detailHtml("bare");
    const code = await owner(async (client) => {
      const res = await client.query("SELECT referral_code FROM app_user WHERE id = $1", [
        ids.bare,
      ]);
      return res.rows[0].referral_code;
    });
    expect(code).toBeNull();
  });

  it("davetle gelen hesap: davet durumu görünür, davet edenin kimliği görünmez", async () => {
    const html = text(await detailHtml("invitee"));
    expect(html).toContain("Davetle mi geldi Evet · Geçerli");
    expect(html).not.toContain(`ayse.isik.${TAG}`);
    expect(html).not.toContain("Ayşe");
  });

  it("telefon kimliği olan hesap: telefon maskeli gösterilir", async () => {
    const html = text(await detailHtml("phone"));
    expect(html).toMatch(/Telefon \+90 ••• ••• ••\d\d/);
    expect(html).not.toMatch(/\+90555\d{7}/);
  });
});
