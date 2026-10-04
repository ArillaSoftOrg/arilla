/**
 * Arama tanısı, sorunlu sorgular ve /ara arama kalitesi sayacı (karar 0054).
 * Gerçek yerel Postgres ve Redis; `next/*` taklit edilir. Uzak adres görülürse durur.
 *
 * - moderatör tanıyı (adım adım + "bu ürün neden yok") ve sözlükteki
 *   "Sorunlu sorgular"ı kullanır; normal kullanıcı 404, anonim girişe gider
 * - tanı hiçbir şey yazmaz (`search_query_day`, `query_resolution`)
 * - /ara metin araması sayacı yazar, kişisel veri içeren sorguyu yazmaz,
 *   sayfa/sekme gezinmesini ikinci kez saymaz
 * - "Sözlüğe ekle" formu ön doldurur, kendisi yazmaz
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  after: [] as (() => unknown)[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
  }),
  headers: async () => new Headers(),
}));

// `after()` istek bağlamı ister; testte geri çağrılar toplanır ve elle beklenir.
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    state.after.push(fn);
  },
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
const WORD = `wqz${suffix}`;
const MISSING = `yokyok${suffix}`;
const tokens: Record<"moderator" | "user", string> = { moderator: "", user: "" };
const userIds: number[] = [];
let merchantId = 0;
let productId = 0;

const sp = <T extends object>(value: T) => ({ searchParams: Promise.resolve(value) });

async function render(page: Promise<ReactElement>): Promise<string> {
  return renderToStaticMarkup(await page);
}

async function counts() {
  return owner(async (client) => {
    const r = await client.query(
      `SELECT (SELECT count(*) FROM search_query_day)::int AS sq,
              (SELECT count(*) FROM query_resolution)::int AS qr,
              (SELECT COALESCE(sum(hit_count), 0)::int FROM query_resolution) AS hits`,
    );
    return r.rows[0];
  });
}

async function dayRow(queryNorm: string) {
  return owner(async (client) => {
    const r = await client.query(
      "SELECT searches, zero_results, fallbacks, unrecognized_terms FROM search_query_day WHERE query_norm = $1",
      [queryNorm],
    );
    return r.rows;
  });
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    for (const role of ["moderator", "user"] as const) {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id",
        [`s2web-${role}-${suffix}@test.local`, role],
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
      `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
       VALUES ($1, 'S2 Web', $2, 'xml_feed', 70) RETURNING id`,
      [`s2web-${suffix}`, `s2web-${suffix}.test`],
    );
    merchantId = Number(m.rows[0].id);
    const p = await client.query(
      `INSERT INTO product (slug, title, min_price, offer_count) VALUES ($1, $2, 120000, 1) RETURNING id`,
      [`s2web-urun-${suffix}`, `Deneme ${WORD} Lamba`],
    );
    productId = Number(p.rows[0].id);
    await client.query(
      `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price)
       VALUES ($1, $2, 'w-1', $3, 'S2 Web', 120000)`,
      [merchantId, productId, `https://s2web-${suffix}.test/1`],
    );
  });
});

afterAll(async () => {
  await owner(async (client) => {
    await client.query("DELETE FROM search_query_day WHERE query_norm LIKE $1", [`%${suffix}%`]);
    await client.query("DELETE FROM query_resolution WHERE query_norm LIKE $1", [`%${suffix}%`]);
    await client.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
    await client.query("DELETE FROM product WHERE id = $1", [productId]);
    await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [userIds]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [userIds]);
  });
  await ownerPool?.end();
});

beforeEach(() => {
  state.token = undefined;
  state.after = [];
});

async function runAfter(): Promise<void> {
  const pending = state.after.splice(0);
  for (const fn of pending) await fn();
}

describe("/ara metin araması — arama kalitesi sayacı", () => {
  async function publicSearch(query: string, options: { page?: number; sort?: string } = {}) {
    const { TextSearchResults } = await import("../../ara/text-search-results.tsx");
    const html = renderToStaticMarkup(
      await TextSearchResults({
        query,
        queryObject: null,
        isNewSearch: true,
        requestedSort: (options.sort ?? "balanced") as "balanced",
        page: options.page ?? 1,
        hrefFor: () => "/ara",
      }),
    );
    await runAfter();
    return html;
  }

  it("sonuçlu ve sonuçsuz arama sayılır; tanınmayan kelime yazılır", async () => {
    await publicSearch(WORD);
    await publicSearch(WORD);
    expect(await dayRow(WORD)).toEqual([
      { searches: 2, zero_results: 0, fallbacks: 0, unrecognized_terms: [WORD] },
    ]);

    await publicSearch(`${MISSING} lamba`);
    const [missing] = await dayRow(`${MISSING} lamba`);
    expect(missing.searches).toBe(1);
    expect(missing.zero_results).toBe(1);
    expect(missing.unrecognized_terms).toContain(MISSING);
  });

  it("kişisel veri içeren sorgu yazılmaz; ikinci sayfa ve başka sekme sayılmaz", async () => {
    const before = await counts();
    await publicSearch(`beni ara 0532 123 45 67 ${suffix}`);
    await publicSearch(`${suffix}@ornek.com`);
    await publicSearch(WORD, { page: 2 });
    await publicSearch(WORD, { sort: "best_deal" });
    const after = await counts();
    expect(after.sq).toBe(before.sq);
    expect(await dayRow(WORD)).toEqual([expect.objectContaining({ searches: 2 })]);
  });
});

describe("/yonetim/arama/tani", () => {
  it("anonim girişe, normal kullanıcı 404, moderatör kullanır", async () => {
    const { default: Page } = await import("./tani/page.tsx");
    expect(await outcome(() => Page(sp({ q: WORD })))).toBe("login");
    state.token = tokens.user;
    expect(await outcome(() => Page(sp({ q: WORD })))).toBe("404");
  });

  it("adım adım boru hattı + ürün nedeni; tanı hiçbir şey yazmaz", async () => {
    const { default: Page } = await import("./tani/page.tsx");
    state.token = tokens.moderator;
    const before = await counts();
    const html = await render(Page(sp({ q: `${WORD} kırmızı`, urun: `s2web-urun-${suffix}` })));
    for (const text of [
      "Boru hattı",
      "Ayrıştırıcı",
      "Sözlük eşleşmeleri",
      "Anlaşılanlar",
      "Aday kapıları",
      "Sıralama",
      "Netleştirme",
      "Ham veri",
      "Bu ürün neden burada değil?",
      `Deneme ${WORD} Lamba`,
    ]) {
      expect(html).toContain(text);
    }
    const missingHtml = await render(Page(sp({ q: MISSING, urun: String(productId) })));
    expect(missingHtml).toContain("Listede değil.");
    expect(missingHtml).toContain("Metin kapısı");
    const badRef = await render(Page(sp({ q: WORD, urun: "x'; drop" })));
    expect(badRef).toContain("Ürün kimliği (sayı) ya da adres adı (slug) gir.");

    expect(await counts()).toEqual(before);
    expect(state.after).toHaveLength(0);
  });
});

describe("/yonetim/sozluk — Sorunlu sorgular", () => {
  it("normal kullanıcı 404", async () => {
    const { default: Page } = await import("../sozluk/page.tsx");
    state.token = tokens.user;
    expect(await outcome(() => Page(sp({})))).toBe("404");
  });

  it("moderatör sorunlu sorguları, İncele ve Sözlüğe ekle bağlantılarını görür", async () => {
    const { default: Page } = await import("../sozluk/page.tsx");
    state.token = tokens.moderator;
    const html = await render(Page(sp({ gun: "7", sorun: "zero" })));
    expect(html).toContain("Sorunlu sorgular");
    expect(html).not.toContain("kademe 3");
    expect(html).toContain(`${MISSING} lamba`);
    expect(html).toContain(
      `href="/yonetim/arama/tani?q=${encodeURIComponent(`${MISSING} lamba`).replace(/%20/g, "+")}"`,
    );
    expect(html).toContain(`/yonetim/sozluk?ekle=${MISSING}&amp;dogrula=`);
  });

  it("Sözlüğe ekle formu ön doldurur ve yazmaz; doğrulama bağlantısı tanıya gider", async () => {
    const { default: Page } = await import("../sozluk/page.tsx");
    state.token = tokens.moderator;
    const lexiconBefore = await owner(async (c) =>
      Number((await c.query("SELECT count(*) FROM lexicon")).rows[0].count),
    );
    const html = await render(Page(sp({ ekle: MISSING, dogrula: `${MISSING} lamba` })));
    expect(html).toContain(`value="${MISSING}"`);
    expect(html).toContain("kaydetmeden hiçbir şey yazılmaz");
    expect(html).toContain("Sorguyu tanıda incele");
    const lexiconAfter = await owner(async (c) =>
      Number((await c.query("SELECT count(*) FROM lexicon")).rows[0].count),
    );
    expect(lexiconAfter).toBe(lexiconBefore);
  });
});
