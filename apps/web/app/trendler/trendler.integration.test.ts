/**
 * `/trendler` ve `/trendler/<slug>` web siniri (karar 0077): sayfalar arayuz
 * olmadan dogrudan cagrilir, gercek yerel Postgres ile. `next/*` taklit
 * edilir; erisim kapisi, sorgular ve sayfa cikti gercektir.
 */
import { createDatabase } from "@arilla/db";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new NotFoundSignal();
  },
}));
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
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

const PREFIX = "test-trendler-page";
const IMAGE = (n: number) => `https://img.test.example/${PREFIX}/${n}.jpg`;

async function call(fn: () => Promise<unknown>): Promise<{ html?: string; outcome: string }> {
  try {
    const element = (await fn()) as ReactElement;
    return { html: renderToStaticMarkup(element), outcome: "ok" };
  } catch (error) {
    if (error instanceof RedirectSignal) return { outcome: error.to };
    if (error instanceof NotFoundSignal) return { outcome: "404" };
    throw error;
  }
}

async function cleanup(): Promise<void> {
  await owner(async (client) => {
    await client.query("DELETE FROM trend WHERE slug LIKE $1", [`${PREFIX}%`]);
    await client.query("DELETE FROM product WHERE slug LIKE $1", [`${PREFIX}%`]);
  });
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await cleanup();
  await owner(async (client) => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const row = await client.query(
        `INSERT INTO product (slug, title, primary_image_url, min_price, in_stock_count, offer_count)
         VALUES ($1, $2, $3, $4, 1, 3) RETURNING id`,
        [`${PREFIX}-p${i}`, `Sayfa test ürünü ${i}`, IMAGE(i), (i + 1) * 10_000],
      );
      ids.push(Number(row.rows[0].id));
    }
    const mk = async (slug: string, title: string, order: number, status = "published") => {
      const row = await client.query(
        `INSERT INTO trend (slug, title, description, category, status, featured, sort_order)
         VALUES ($1, $2, $3, 'guzellik', $4, TRUE, $5) RETURNING id`,
        [slug, title, `${title} için kısa açıklama.`, status, order],
      );
      return Number(row.rows[0].id);
    };
    const ok = await mk(`${PREFIX}-ok`, "Sayfa Testi Trendi", 1);
    // sort_order id sirasinin tersi: sayfa siraya uymali.
    for (const [rank, id] of [...ids].reverse().entries()) {
      await client.query(
        "INSERT INTO trend_product (trend_id, product_id, sort_order) VALUES ($1,$2,$3)",
        [ok, id, rank],
      );
    }
    await mk(`${PREFIX}-empty`, "Boş Test Trendi", 2);
    const draft = await mk(`${PREFIX}-draft`, "Taslak Test Trendi", 3, "draft");
    for (const [rank, id] of ids.slice(0, 5).entries()) {
      await client.query(
        "INSERT INTO trend_product (trend_id, product_id, sort_order) VALUES ($1,$2,$3)",
        [draft, id, rank],
      );
    }
  });
});

beforeEach(() => {
  vi.stubEnv("PRODUCT_ACCESS", "open");
});

afterAll(async () => {
  await cleanup();
  vi.unstubAllEnvs();
  await ownerPool?.end();
});

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("/trendler", () => {
  it("yayinlanmis, urunlu trendi kart olarak listeler; bos ve taslak trendi gostermez", async () => {
    const { default: Page } = await import("./page.tsx");
    expect((await call(() => Page())).outcome).toBe("ok"); // kapi gecti; govde Suspense icinde
    const { TrendlerContent } = await import("./trendler-content.tsx");
    const { outcome, html } = await call(() => TrendlerContent());
    expect(outcome).toBe("ok");
    expect(html).toContain(`href="/trendler/${PREFIX}-ok"`);
    expect(html).toContain("Sayfa Testi Trendi");
    expect(html).not.toContain(`${PREFIX}-empty`);
    expect(html).not.toContain(`${PREFIX}-draft`);
    // Sayfa baslik hiyerarsisi: tek h1, kesit anchor gezinmesi, liste semantigi.
    expect(html?.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain('href="#trend-all"');
    expect(html).toContain('role="list"');
    expect(html).toContain("<details");
  });

  it("urun kapaliyken (oturumsuz) erisim kapisina takilir", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "");
    const { default: Page } = await import("./page.tsx");
    const { outcome } = await call(() => Page());
    expect(outcome).not.toBe("ok");
  });
});

describe("/trendler/[slug]", () => {
  it("kapak, baslik, tek cumle aciklama ve siraya gore urun izgarasi; makale govdesi yok", async () => {
    const { default: Page } = await import("./[slug]/page.tsx");
    const { outcome, html } = await call(() => Page(params(`${PREFIX}-ok`)));
    expect(outcome).toBe("ok");
    expect(html).toContain("Sayfa Testi Trendi");
    expect(html).toContain("Sayfa Testi Trendi için kısa açıklama.");
    expect(html).toContain('href="/trendler"');
    expect(html).toContain("Trendler");
    // Kapak = temsilci (sort_order 0 = p5) urun gorseli.
    expect(html).toContain(IMAGE(5));
    // Urun tiklamasi mevcut fiyat karsilastirma sayfasina gider, sort_order sirasinda.
    const hrefs = [...(html ?? "").matchAll(/href="(\/urun\/[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([5, 4, 3, 2, 1, 0].map((n) => `/urun/${PREFIX}-p${n}`));
    expect(html?.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).not.toContain("<article");
    expect(html).not.toContain("<h2");
    expect(html).toContain("6 ürün");
  });

  it("gecersiz, bilinmeyen, bos ve taslak slug 404", async () => {
    const { default: Page } = await import("./[slug]/page.tsx");
    for (const slug of [
      "../etc/passwd",
      "BÜYÜK",
      `${PREFIX}-yok`,
      `${PREFIX}-empty`,
      `${PREFIX}-draft`,
    ]) {
      expect((await call(() => Page(params(slug)))).outcome, slug).toBe("404");
    }
  });

  it("metadata: baslik, kisa aciklama, canonical; Article/BlogPosting yapisal verisi yok", async () => {
    const { generateMetadata } = await import("./[slug]/page.tsx");
    const meta = await generateMetadata(params(`${PREFIX}-ok`));
    expect(meta.title).toBe("Sayfa Testi Trendi – Arilla");
    expect(meta.description).toBe("Sayfa Testi Trendi için kısa açıklama.");
    expect(meta.alternates?.canonical).toBe(`/trendler/${PREFIX}-ok`);
    expect(JSON.stringify(meta)).not.toMatch(/Article|BlogPosting/);
    expect(await generateMetadata(params(`${PREFIX}-yok`))).toEqual({});
  });
});
