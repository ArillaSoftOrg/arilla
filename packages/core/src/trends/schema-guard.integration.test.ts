/**
 * Eksik 0056 semasi (karar 0077): gercek PostgreSQL'de, YALNIZCA yerel sunucuda
 * olusturulan gecici veritabanlariyla. Uretim ya da paylasilan test veritabanina
 * dokunulmaz; her durum kendi bos veritabaninda calisir ve test sonunda silinir.
 */
import { createDatabase } from "@arilla/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPublicTrends, getTrendBySlug } from "./get-trends.ts";
import { resetTrendSchemaWarning } from "./schema-guard.ts";

const SUFFIX = `${process.pid}_${Date.now()}`;
const NO_SCHEMA = `trends_guard_none_${SUFFIX}`;
const NO_PRODUCT = `trends_guard_noproduct_${SUFFIX}`;

function ownerUrl(): URL {
  const raw = process.env.DATABASE_URL_OWNER;
  if (!raw) throw new Error("DATABASE_URL_OWNER tanimli degil");
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(
      `DATABASE_URL_OWNER yerel degil (${url.hostname}); test yalnizca yerel calisir.`,
    );
  }
  return url;
}

function withDatabase(name: string): string {
  const url = ownerUrl();
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: withDatabase("postgres") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe("eksik trend semasi - gercek DB", () => {
  beforeAll(async () => {
    await admin(async (client) => {
      await client.query(`CREATE DATABASE ${NO_SCHEMA}`);
      await client.query(`CREATE DATABASE ${NO_PRODUCT}`);
    });
    // `trend` ve `trend_product` VAR, `product` YOK: baska tablonun eksigi maskelenmemeli.
    const client = new Client({ connectionString: withDatabase(NO_PRODUCT) });
    await client.connect();
    try {
      await client.query(`
        CREATE TABLE trend (
          id BIGINT PRIMARY KEY, slug TEXT, title TEXT, description TEXT, category TEXT,
          hero_image_url TEXT, status TEXT, featured BOOLEAN, trend_type TEXT,
          sort_order INTEGER, active_from TIMESTAMPTZ, active_until TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
        CREATE TABLE trend_product (trend_id BIGINT, product_id BIGINT, sort_order INTEGER,
          created_at TIMESTAMPTZ DEFAULT now());
        INSERT INTO trend (id, slug, title, description, category, status, featured, trend_type,
          sort_order) VALUES (1, 'x', 't', 'd', 'moda', 'published', false, 'evergreen', 0);`);
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await admin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${NO_SCHEMA} WITH (FORCE)`);
      await client.query(`DROP DATABASE IF EXISTS ${NO_PRODUCT} WITH (FORCE)`);
    });
  });

  it("trend tablosu yoksa liste bos, detay null; uyari loglanir, hata firlatilmaz", async () => {
    resetTrendSchemaWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = createDatabase(withDatabase(NO_SCHEMA));
    try {
      expect(await getPublicTrends(db)).toEqual([]);
      expect(await getTrendBySlug(db, "kuru-ciltlere-son")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      await db.$client.end();
    }
  });

  it("baska tablo (product) eksikse maskelenmez, hata firlatilir", async () => {
    resetTrendSchemaWarning();
    const db = createDatabase(withDatabase(NO_PRODUCT));
    try {
      await expect(getPublicTrends(db)).rejects.toThrow();
    } finally {
      await db.$client.end();
    }
  });
});
