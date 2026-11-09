/**
 * Aktif indeks cozumleme gercek veritabaninda (migration 0110, karar 0181): tohum satir uretim
 * indeksini (`jina-embeddings-v3`, `product_text_embedding`) active olarak verir.
 */
import { describe, expect, it } from "vitest";
import { getTestDb } from "../../test-db.ts";
import {
  DEFAULT_SEMANTIC_INDEX,
  resetActiveIndexCache,
  resolveSemanticIndex,
} from "./active-index.ts";

describe("embedding_index aktif satiri", () => {
  it("tohum satir varsayilan uretim indeksiyle birebir ayni", async () => {
    resetActiveIndexCache();
    const result = await resolveSemanticIndex(getTestDb(), { env: {} });
    expect(result).toEqual({ index: DEFAULT_SEMANTIC_INDEX, source: "db" });
  });
});
