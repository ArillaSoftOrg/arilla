/**
 * Entegrasyon testleri icin kendi kendine yeten benzerlik katalogu.
 * `similarity_edge` toplu isin (python -m similarity) ciktisidir ve tohum onu
 * yazmaz; tabloda "ne varsa" ilk satiri alan bir test temiz veritabaninda NaN
 * kimlikle kosar. Bu fixture aktif bir magaza, bir capa ve skoru bilinen
 * alternatifler kurar; kenarlar YALNIZCA `product_a = capa` yonunde yazilir
 * (ters yon aramasi da sinanabilsin).
 *
 * Yalnizca testlerden cagrilir (`test-db.ts` ile ayni sozlesme).
 */
import { withOwnerClient } from "../test-db.ts";

export interface SimilarityFixture {
  merchantId: number;
  anchorId: number;
  /** Skora gore azalan sirada: `scores[i]` `alternativeIds[i]`'nin skorudur. */
  alternativeIds: number[];
  scores: number[];
  cleanup(): Promise<void>;
}

export async function createSimilarityFixture(
  label: string,
  scores: readonly number[] = [0.95, 0.9, 0.85, 0.8],
): Promise<SimilarityFixture> {
  const suffix = `${label}-${Date.now()}`;
  const domain = `${suffix}.example.test`;
  return withOwnerClient(async (client) => {
    const merchant = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type)
       VALUES ($1, 'Benzerlik Test Magazasi', $2, 'xml_feed') RETURNING id`,
      [`sim-${suffix}`, domain],
    );
    const merchantId = Number(merchant.rows[0].id);

    const product = async (key: string, price: number): Promise<number> => {
      const row = await client.query(
        `INSERT INTO product (slug, title, min_price, max_price, offer_count, in_stock_count)
         VALUES ($1, $2, $3, $3, 1, 1) RETURNING id`,
        [`sim-${key}-${suffix}`, `Benzerlik ${key} ${suffix}`, price],
      );
      const id = Number(row.rows[0].id);
      await client.query(
        `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw,
                            current_price, is_active, in_stock)
         VALUES ($1, $2, $3, $4, $3, $5, TRUE, TRUE)`,
        [merchantId, id, `sim-${key}-${suffix}`, `https://${domain}/${key}`, price],
      );
      return id;
    };

    const anchorId = await product("anchor", 50_000);
    const alternativeIds: number[] = [];
    for (const [index, score] of scores.entries()) {
      const id = await product(`alt-${index}`, 40_000 + index * 1_000);
      alternativeIds.push(id);
      await client.query(
        "INSERT INTO similarity_edge (product_a, product_b, kind, score) VALUES ($1, $2, 'visual', $3)",
        [anchorId, id, score],
      );
    }

    const ids = [anchorId, ...alternativeIds];
    return {
      merchantId,
      anchorId,
      alternativeIds,
      scores: [...scores],
      cleanup: () =>
        withOwnerClient(async (owner) => {
          await owner.query(
            "DELETE FROM similarity_edge WHERE product_a = ANY($1) OR product_b = ANY($1)",
            [ids],
          );
          await owner.query("DELETE FROM offer WHERE merchant_id = $1", [merchantId]);
          await owner.query("DELETE FROM product WHERE id = ANY($1)", [ids]);
          await owner.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
        }),
    };
  });
}
