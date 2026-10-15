/**
 * Karar 0114: eslesmemis besleme teklifleri - gercek (yalitilmis) Postgres.
 * Yalnizca kendi `t114` verisini yazar ve siler. Sorgu kendi metnimizle
 * (benzersiz arama kelimesi) daraltilir; tablolar baska veri tasiyabilir.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { listFeedOffers } from "./list-feed-offers.ts";

const TAG = `t114${Date.now().toString(36).slice(-6)}`;

describe("listFeedOffers - entegrasyon", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchant = async (slug: string, active: boolean) =>
        (
          await client.query<{ id: string }>(
            `INSERT INTO merchant (slug, name, domain, source_type, is_active)
             VALUES ($1, $1, $1 || '.test.invalid', 'affiliate_network', $2) RETURNING id`,
            [`${TAG}-${slug}`, active],
          )
        ).rows[0]?.id;
      const ali = await merchant("ali", true);
      const tr = await merchant("tr", true);
      const off = await merchant("off", false);
      const product = (
        await client.query<{ id: string }>(
          "INSERT INTO product (slug, title) VALUES ($1, $1) RETURNING id",
          [`${TAG}-p`],
        )
      ).rows[0]?.id;
      const offer = (
        m: string | undefined,
        ext: string,
        price: number,
        currency: string,
        extra = "",
      ) =>
        client.query(
          `INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price, currency${extra ? ", product_id" : ""})
           VALUES ($1, $2, 'https://x.invalid/' || $2, $3, $4, $5${extra ? ", $6" : ""})`,
          extra
            ? [m, ext, `${TAG} ${ext}`, price, currency, extra]
            : [m, ext, `${TAG} ${ext}`, price, currency],
        );
      await offer(ali, "usd-a", 2211, "USD");
      await offer(ali, "usd-b", 999, "USD");
      await offer(tr, "try-pahali", 50_000, "TRY");
      await offer(tr, "try-uygun", 10_000, "TRY");
      await offer(tr, "try-eslesmis", 1_000, "TRY", product);
      await offer(off, "kapali", 100, "TRY");
      await client.query(
        `INSERT INTO fx_rate (source, base, quote, rate, rate_kind, effective_date, bulletin)
         VALUES ('tcmb', 'USD', 'TRY', 49.3929, 'forex_selling', '2099-01-01', $1)
         ON CONFLICT DO NOTHING`,
        [TAG],
      );
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug LIKE $1)",
        [`${TAG}-%`],
      );
      await client.query("DELETE FROM product WHERE slug = $1", [`${TAG}-p`]);
      await client.query("DELETE FROM merchant WHERE slug LIKE $1", [`${TAG}-%`]);
      await client.query("DELETE FROM fx_rate WHERE bulletin = $1", [TAG]);
    });
  });

  it("yurt ici: yalnizca eslesmemis TRY teklifler, fiyat siralamasi", async () => {
    const page = await listFeedOffers(db, { kind: "domestic", q: TAG, sort: "price" });
    expect(page.sort).toBe("price");
    expect(page.items.map((i) => i.title)).toEqual([`${TAG} try-uygun`, `${TAG} try-pahali`]);
  });

  it("yurt disi: orijinal USD korunur, fiyat siralamasina girmez, kur varsa yaklasik TL", async () => {
    const page = await listFeedOffers(
      db,
      { kind: "international", q: TAG, sort: "price" },
      new Date("2099-01-02T10:00:00Z"),
    );
    expect(page.sort).toBe("recent");
    const a = page.items.find((i) => i.title.endsWith("usd-a"));
    expect(a).toMatchObject({ currency: "USD", priceMinor: 2211 });
    expect(a?.approx?.approxTryMinor).toBe(109208);
    expect(a?.approx?.quote.effectiveDate).toBe("2099-01-01");
    expect(page.items.every((i) => i.currency === "USD")).toBe(true);
  });

  it("kur eskiyse yaklasik TL uretilmez", async () => {
    const page = await listFeedOffers(
      db,
      { kind: "international", q: TAG },
      new Date("2099-02-01T10:00:00Z"),
    );
    expect(page.items.length).toBe(2);
    expect(page.items.every((i) => i.approx === null)).toBe(true);
  });
});
