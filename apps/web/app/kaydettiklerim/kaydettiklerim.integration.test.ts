/**
 * `/kaydettiklerim` fiyat değişimi (karar 0159) - gerçek yerel Postgres, gerçek sayfa;
 * `next/*` taklit. Giriş kapısı, kullanıcı izolasyonu ve göstergenin çizimi.
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "session" && state.token ? { name, value: state.token } : undefined,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ refresh: () => {} }),
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

const suffix = `kayit-${Date.now().toString(36)}`;
const HOUR = 3_600_000;
const savedAt = new Date(Date.now() - 72 * HOUR);
const ids = {
  users: [] as number[],
  merchant: 0,
  products: [] as number[],
  offers: [] as number[],
};
const tokens: Record<"a" | "b", string> = { a: "", b: "" };

async function render(): Promise<string> {
  const { default: Page } = await import("./page.tsx");
  return renderToStaticMarkup((await Page()) as ReactElement);
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    const m = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type, is_active)
       VALUES ($1, 'Kayıt mağazası', $2, 'xml_feed', TRUE) RETURNING id`,
      [suffix, `${suffix}.test`],
    );
    ids.merchant = Number(m.rows[0].id);
    const product = async (key: string, price: number, past: number | null) => {
      const row = await client.query(
        "INSERT INTO product (slug, title, min_price, offer_count) VALUES ($1, $2, $3, 1) RETURNING id",
        [`${key}-${suffix}`, `Kayıt ürünü ${key}`, price],
      );
      const productId = Number(row.rows[0].id);
      ids.products.push(productId);
      const offer = await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, currency)
         VALUES ($1, $2, $3, $4, $5, $6, 'TRY') RETURNING id`,
        [ids.merchant, productId, `${key}-${suffix}`, `https://${suffix}.test/${key}`, key, price],
      );
      const offerId = Number(offer.rows[0].id);
      ids.offers.push(offerId);
      if (past !== null) {
        // Kayıt anındaki gözlem ve bugünkü fiyatın gözlemi (toplayıcı her koşuda yazar).
        for (const [at, value] of [
          [savedAt.getTime() - HOUR, past],
          [Date.now() - HOUR, price],
        ] as const) {
          await client.query(
            "INSERT INTO price_point (offer_id, observed_at, price, in_stock) VALUES ($1, $2, $3, TRUE)",
            [offerId, new Date(at).toISOString(), value],
          );
        }
      }
      return productId;
    };
    const dusen = await product("dusen", 750_00, 1000_00);
    const veriyok = await product("veriyok", 500_00, null);
    const baskasi = await product("baskasi", 300_00, 200_00);

    for (const key of ["a", "b"] as const) {
      const u = await client.query("INSERT INTO app_user (email) VALUES ($1) RETURNING id", [
        `${key}-${suffix}@test.local`,
      ]);
      const userId = Number(u.rows[0].id);
      ids.users.push(userId);
      tokens[key] = generateRawToken();
      await client.query(
        "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [userId, hashToken(tokens[key])],
      );
    }
    const [a, b] = ids.users as [number, number];
    for (const [userId, productId] of [
      [a, dusen],
      [a, veriyok],
      [b, baskasi],
    ] as const) {
      await client.query(
        "INSERT INTO saved_item (user_id, product_id, created_at) VALUES ($1, $2, $3)",
        [userId, productId, savedAt.toISOString()],
      );
    }
  });
});

beforeEach(() => {
  vi.stubEnv("PRODUCT_ACCESS", "open");
  state.token = undefined;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await owner(async (client) => {
    await client.query("DELETE FROM saved_item WHERE user_id = ANY($1)", [ids.users]);
    await client.query("DELETE FROM session WHERE user_id = ANY($1)", [ids.users]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [ids.users]);
    await client.query("DELETE FROM price_point WHERE offer_id = ANY($1)", [ids.offers]);
    await client.query("DELETE FROM offer WHERE id = ANY($1)", [ids.offers]);
    await client.query("DELETE FROM product WHERE id = ANY($1)", [ids.products]);
    await client.query("DELETE FROM merchant WHERE id = $1", [ids.merchant]);
  });
  await ownerPool?.end();
});

describe("/kaydettiklerim fiyat değişimi", () => {
  it("girişsiz ziyaretçi sayfayı (ve fiyat verisini) göremez", async () => {
    await expect(render()).rejects.toMatchObject({ to: "/giris" });
  });

  it("kullanıcı kendi kayıtlarının göstergesini görür", async () => {
    state.token = tokens.a;
    const html = await render();
    expect(html).toContain("Kayıt ürünü dusen");
    expect(html).toContain("Kaydettiğinden beri 250 TL düştü (%25)");
    expect(html).toContain("Karşılaştırma için yeterli veri yok");
  });

  it("başka kullanıcının kaydı ve fiyat değişimi sızmaz", async () => {
    state.token = tokens.a;
    const a = await render();
    expect(a).not.toContain("Kayıt ürünü baskasi");
    state.token = tokens.b;
    const b = await render();
    expect(b).toContain("Kayıt ürünü baskasi");
    expect(b).toContain("Kaydettiğinden beri 100 TL arttı (%50)");
    expect(b).not.toContain("Kayıt ürünü dusen");
  });
});
