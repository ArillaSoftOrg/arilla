/**
 * Karar 0114 / migration 0069: /teklifler aramasi trigram yerine kelime tabanli tam
 * metin. Arama kalitesi regresyonu - gercek (yalitilmis) Postgres, gercek AliExpress
 * baslik bicimleri. Yalnizca kendi verisini yazar ve siler.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { feedOfferTsQuery, listFeedOffers } from "./list-feed-offers.ts";

const TAG = `t114s${Date.now().toString(36).slice(-6)}`;
const TITLES = [
  "Airtight Coffee Bean Storage Jar Stainless Steel Canister With CO2 Release Valve",
  "QX2E Premium Manual Coffee Grinders With Adjustable Setting",
  "Winter Motorcycle Handlebar Pogies Muffs Waterproof E Bike Scooter",
  "Kadın Deri Çanta Omuz Çantası Siyah",
  "iPhone 15 Pro Max Silikon Kılıf",
  "USB-C to Lightning Cable 2m",
];

describe("besleme teklifi aramasi (tam metin, 0069)", () => {
  let db: Database;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (client) => {
      const merchantId = (
        await client.query<{ id: string }>(
          `INSERT INTO merchant (slug, name, domain, source_type, is_active)
           VALUES ($1, $1, $1 || '.test.invalid', 'affiliate_network', TRUE) RETURNING id`,
          [TAG],
        )
      ).rows[0]?.id;
      for (const [i, title] of TITLES.entries()) {
        await client.query(
          `INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price, currency)
           VALUES ($1, $2, 'https://x.invalid/' || $2, $3, 1000, 'TRY')`,
          [merchantId, `${TAG}-${i}`, `${title} ${TAG}`],
        );
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (client) => {
      await client.query(
        "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = $1)",
        [TAG],
      );
      await client.query("DELETE FROM merchant WHERE slug = $1", [TAG]);
    });
  });

  const titles = async (q: string) =>
    (await listFeedOffers(db, { kind: "domestic", q: `${q} ${TAG}` })).items.map((item) =>
      item.title.replace(` ${TAG}`, ""),
    );

  it("tek ve cok kelime: tum kelimeler gecmeli (AND)", async () => {
    expect(await titles("coffee")).toHaveLength(2);
    expect(await titles("coffee grinder")).toEqual([TITLES[1]]);
    expect(await titles("coffee scooter")).toEqual([]);
  });

  it("kelime basi eslesmesi ve buyuk/kucuk harf", async () => {
    expect(await titles("COFF")).toHaveLength(2);
    expect(await titles("stainless ste")).toEqual([TITLES[0]]);
    expect(await titles("iphone")).toEqual([TITLES[4]]);
  });

  it("Turkce karakterler", async () => {
    expect(await titles("çanta")).toEqual([TITLES[3]]);
    expect(await titles("kılıf")).toEqual([TITLES[4]]);
    expect(await titles("deri siyah")).toEqual([TITLES[3]]);
  });

  it("noktalama ve tire: kelimelere bolunur", async () => {
    expect(await titles("usb-c")).toEqual([TITLES[5]]);
    expect(await titles("co2 valve")).toEqual([TITLES[0]]);
  });

  it("sorgu sozdizimi kullanici metninden etkilenmez", async () => {
    // Operatorler kelime degil: yalnizca "coffee" kalir.
    for (const q of ["coffee & | ! ( ) :* <->", "\\coffee"]) {
      expect(await titles(q)).toHaveLength(2);
    }
    // SQL benzeri metin hata vermez; "or" ve "1" de kelime sayilip AND ile aranir.
    expect(await titles("coffee')) OR 1=1 --")).toEqual([]);
    expect(feedOfferTsQuery("!!! ---")).toBeNull();
    expect(feedOfferTsQuery("a b c d e f g h i j")).toBe(
      "a:* & b:* & c:* & d:* & e:* & f:* & g:* & h:*",
    );
  });
});
