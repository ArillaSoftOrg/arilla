/**
 * Katalog kalitesi sayfası ve eşleştirme kanıtı (karar 0053). Gerçek yerel
 * Postgres; `next/*` taklit edilir. Uzak adres görülürse durur.
 *
 * - moderatör (catalog.read) sayfayı görür; normal kullanıcı 404, anonim girişe
 * - bağlantılar yalnızca izinli yönetim sayfalarına; tam mağaza adresi yok
 * - adaysız teklif durumu teklif listesinde açıklamasıyla görünür
 * - eşleştirme kuyruğu kanıtı (skor ölçeği, neden, kardeş teklif) çizilir
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

const TAG = `kqw${Date.now().toString(36)}`;
const tokens: Record<"moderator" | "user", string> = { moderator: "", user: "" };
const userIds: number[] = [];
const ids: Record<string, number> = {};

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    for (const role of ["moderator", "user"] as const) {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id",
        [`${TAG}-${role}@test.local`, role],
      );
      const id = Number(res.rows[0].id);
      userIds.push(id);
      tokens[role] = generateRawToken();
      await client.query(
        "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [id, hashToken(tokens[role])],
      );
    }

    const m = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type)
       VALUES ($1, $2, $3, 'xml_feed') RETURNING id`,
      [`${TAG}-magaza`, `${TAG} Mağaza`, `${TAG}.test`],
    );
    ids.merchant = Number(m.rows[0].id);
    const b = await client.query(
      "INSERT INTO brand (slug, name, name_norm) VALUES ($1, $2, $3) RETURNING id",
      [`${TAG}-marka`, `${TAG} Marka`, `${TAG}marka`],
    );
    ids.brand = Number(b.rows[0].id);
    const p = await client.query(
      `INSERT INTO product (slug, title, brand_id, gtin, min_price, offer_count)
       VALUES ($1, $2, $3, '8690000000012', 12900, 1) RETURNING id`,
      [`${TAG}-urun`, `${TAG} Ürün`, ids.brand],
    );
    ids.product = Number(p.rows[0].id);

    const offer = async (key: string, productId: number | null, firstSeen: string) => {
      const r = await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, first_seen_at)
         VALUES ($1, $2, $3, $4, $5, 12900, $6) RETURNING id`,
        [
          ids.merchant,
          productId,
          `${TAG}-${key}`,
          `https://${TAG}.test/${key}?aff=gizli`,
          `${TAG} ${key}`,
          firstSeen,
        ],
      );
      return Number(r.rows[0].id);
    };
    ids.sibling = await offer("kardes", ids.product, new Date().toISOString());
    ids.noCandidate = await offer("adaysiz", null, "2000-01-01T00:00:00Z");
    ids.queued = await offer("kuyruk", null, new Date().toISOString());
    const c = await client.query(
      `INSERT INTO match_candidate (offer_id, product_id, score, method, status, explain, created_at)
       VALUES ($1, $2, 0.7, 'text', 'pending', $3, now() - interval '2 days') RETURNING id`,
      [
        ids.queued,
        ids.product,
        JSON.stringify({
          version: 1,
          method: "text",
          score: 0.7,
          text_similarity: 0.7,
          review: "renk dogrulanamadi: spring-green",
          auto_eligible: false,
          brand_known_both: false,
          brand_equal: false,
          queue_threshold: 0.63,
          auto_accept_threshold: 0.84,
        }),
      ],
    );
    ids.candidate = Number(c.rows[0].id);
  });
});

beforeEach(() => {
  state.token = tokens.moderator;
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query(
      "DELETE FROM match_candidate WHERE offer_id IN (SELECT id FROM offer WHERE merchant_id = $1)",
      [ids.merchant],
    );
    await client.query("DELETE FROM offer WHERE merchant_id = $1", [ids.merchant]);
    await client.query("DELETE FROM product WHERE id = $1", [ids.product]);
    await client.query("DELETE FROM brand WHERE id = $1", [ids.brand]);
    await client.query("DELETE FROM merchant WHERE id = $1", [ids.merchant]);
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [userIds]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [userIds]);
  });
  await ownerPool?.end();
});

async function render(
  load: () => Promise<{ default: (...args: never[]) => unknown }>,
  props?: unknown,
) {
  const { default: Page } = await load();
  const element = (await (Page as (p?: unknown) => Promise<unknown>)(props)) as ReactElement;
  return renderToStaticMarkup(element);
}

const qualityPage = () => render(() => import("./page.tsx"));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");

describe("/yonetim/katalog/kalite", () => {
  it("anonim girişe, normal kullanıcı 404, moderatör görür", async () => {
    state.token = undefined;
    expect(await outcome(qualityPage)).toBe("login");
    state.token = tokens.user;
    expect(await outcome(qualityPage)).toBe("404");
    state.token = tokens.moderator;
    expect(await outcome(qualityPage)).toBe("ok");
  });

  it("adaysız teklif bulgusu ve örneği görünür; bağlantılar yalnızca izinli sayfalara", async () => {
    const html = await qualityPage();
    const visible = text(html);
    expect(visible).toContain("Katalog kalitesi");
    expect(visible).toContain("eşleşmemiş aktif teklifin hiç adayı yok");
    const links = hrefs(html).map((h) => h.replace(/&amp;/g, "&"));
    expect(links).toContain(
      `/yonetim/katalog/teklifler?durum=all&magaza=${ids.merchant}&q=%23${ids.noCandidate}`,
    );
    expect(links).toContain("/yonetim/katalog/teklifler?durum=no_candidate");
    for (const link of links) {
      expect(link).toMatch(/^\/yonetim\/(katalog\/(urunler|teklifler|kalite)|magazalar)(\/|\?|$)/);
    }
    expect(html).not.toContain("aff=gizli");
    expect(html).not.toContain("https://");
  });
});

describe("/yonetim/katalog/teklifler adaysız durum", () => {
  it("açıklama, ilk görülme ve aday kanalları", async () => {
    const html = await render(() => import("../teklifler/page.tsx"), {
      searchParams: Promise.resolve({ durum: "no_candidate", magaza: String(ids.merchant) }),
    });
    const visible = text(html);
    expect(visible).toContain("Hiç aday kaydı olmayan teklife koşu henüz ulaşmamıştır");
    expect(visible).toContain(`${TAG} adaysiz`);
    expect(visible).not.toContain(`${TAG} kuyruk`);
    expect(visible).toContain("barkod/MPN yok · görsel vektörü yok");
  });
});

describe("/yonetim/eslestirme kanıtı", () => {
  it("skor ölçeği, insan nedeni, kimlik uyumu ve kardeş teklif çizilir", async () => {
    const html = await render(() => import("../../eslestirme/page.tsx"), {
      searchParams: Promise.resolve({ magaza: String(ids.merchant) }),
    });
    const visible = text(html);
    expect(visible).toContain("Neden insan bekliyor");
    expect(visible).toContain("renk dogrulanamadi: spring-green");
    expect(visible).toContain("otomatik kabul 0,84");
    expect(visible).toContain("Kuyrukta bekleme: 2 gün");
    expect(visible).toContain("Kimlik uyumu");
    expect(visible).toContain("Adaya bağlı aktif teklifler (1)");
    expect(visible).toContain("Bu mağazanın bu ürüne bağlı başka bir teklifi var");
    expect(html).not.toContain("aff=gizli");
  });

  it("normal kullanıcı kuyruğu göremez", async () => {
    state.token = tokens.user;
    expect(
      await outcome(() =>
        render(() => import("../../eslestirme/page.tsx"), { searchParams: Promise.resolve({}) }),
      ),
    ).toBe("404");
  });
});
