import { describe, expect, it } from "vitest";
import {
  type CategoryStat,
  DEFAULT_STRATEGY_CONFIG,
  type IndexDescriptor,
  isSafeCategoryLiteral,
  resolveStrategyConfig,
  type StrategyInput,
  selectSemanticStrategy,
} from "./strategy.ts";

const NOW = new Date("2026-11-13T12:00:00Z");
const BGE = "bge-m3";
const V = "hnsw-m16-efc64-v1";

const global: IndexDescriptor = {
  id: "pte_d1024_hnsw",
  kind: "global_hnsw",
  modelVersion: BGE,
  indexVersion: V,
  scope: { type: "global" },
  state: "ready",
};
const partialGiyim: IndexDescriptor = {
  id: "pte_d1024_p_giyim",
  kind: "partial_hnsw",
  modelVersion: BGE,
  indexVersion: V,
  scope: { type: "category_top", value: "giyim" },
  state: "ready",
};
const partialUst: IndexDescriptor = {
  id: "pte_d1024_p_ust_giyim",
  kind: "partial_hnsw",
  modelVersion: BGE,
  indexVersion: V,
  scope: { type: "category_path", value: "giyim/ust-giyim" },
  state: "ready",
};
const btree: IndexDescriptor = {
  id: "product_category_idx",
  kind: "btree_category",
  modelVersion: null,
  indexVersion: null,
  scope: { type: "global" },
  state: "ready",
};
const binary: IndexDescriptor = {
  id: "pte_d1024_bin",
  kind: "binary_hnsw",
  modelVersion: BGE,
  indexVersion: V,
  scope: { type: "global" },
  state: "ready",
  qualityVerified: true,
};

const stat = (path: string, rows: number, ageMs = 60_000): [string, CategoryStat] => [
  path,
  { path, rows, computedAt: new Date(NOW.getTime() - ageMs) },
];
const STATS = new Map([
  stat("giyim", 7922),
  stat("giyim/ust-giyim", 1975),
  stat("giyim/ic-giyim", 676),
  stat("giyim/tesettur-giyim", 70),
  stat("bos/kategori", 0),
]);

const input = (over: Partial<StrategyInput> = {}): StrategyInput => ({
  modelVersion: BGE,
  indexVersion: V,
  category: null,
  hasPriceFilter: false,
  inventory: [global, partialGiyim, partialUst, btree],
  categoryStats: STATS,
  now: NOW,
  ...over,
});
const explicit = (path: string) => ({ path, source: "explicit" as const });
const inferred = (path: string) => ({ path, source: "inferred" as const });

describe("geriye uyumluluk ve guvenli geri donus", () => {
  it("envanter bilinmiyorsa (bugunku durum) bugunku yol: legacy_postfilter", () => {
    const d = selectSemanticStrategy(input({ inventory: null, category: explicit("giyim") }));
    expect(d.strategy).toBe("legacy_postfilter");
    expect(d.indexId).toBeNull();
    expect(d.degraded).toBe(true);
    expect(d.categoryMode).toBe("hard");
    expect(d.reasons).toContain("envanter_bilinmiyor");
  });

  it("bugunku Jina uzayinda BGE indeksleri asla secilmez (uzay karismaz)", () => {
    const d = selectSemanticStrategy(input({ modelVersion: "jina-embeddings-v3" }));
    expect(d.strategy).toBe("legacy_postfilter");
    expect(d.reasons).toContain("model_uyusmuyor:pte_d1024_hnsw");
  });

  it("ayni girdi ayni ciktiyi verir (yan etkisiz)", () => {
    const i = input({ category: explicit("giyim/ust-giyim") });
    expect(selectSemanticStrategy(i)).toEqual(selectSemanticStrategy(i));
  });
});

describe("filtresiz ve fiyat filtreli sorgu", () => {
  it("filtresiz -> global HNSW, ef 150", () => {
    const d = selectSemanticStrategy(input());
    expect(d).toMatchObject({ strategy: "global_hnsw", indexId: global.id, efSearch: 150 });
    expect(d.uncategorized).toBe("included");
    expect(d.degraded).toBe(false);
  });

  it("fiyat filtresi anlamdan bagimsiz -> global HNSW", () => {
    const d = selectSemanticStrategy(input({ hasPriceFilter: true }));
    expect(d.strategy).toBe("global_hnsw");
    expect(d.reasons).toContain("fiyat_filtresi_global_uyumlu");
  });

  it("global indeks yoksa binary yalniz izin + kalite dogrulamasiyla", () => {
    const inv = [binary];
    expect(selectSemanticStrategy(input({ inventory: inv })).strategy).toBe("legacy_postfilter");
    const d = selectSemanticStrategy(input({ inventory: inv, config: { allowBinary: true } }));
    expect(d).toMatchObject({ strategy: "binary_rerank", rerankK: 400 });
    const unverified = [{ ...binary, qualityVerified: false }];
    expect(
      selectSemanticStrategy(input({ inventory: unverified, config: { allowBinary: true } }))
        .strategy,
    ).toBe("legacy_postfilter");
  });
});

describe("acik ve tahmin edilen kategori", () => {
  it("tahmin edilen kategori kesin filtre degil: yumusak sinyal + global HNSW", () => {
    const d = selectSemanticStrategy(input({ category: inferred("giyim") }));
    expect(d).toMatchObject({
      strategy: "global_hnsw",
      categoryMode: "soft",
      categoryPath: "giyim",
    });
    expect(d.reasons).toContain("tahmin_edilen_kategori_kesin_filtre_degil");
  });

  it("acik buyuk kategori -> kismi HNSW, ef 400, SQL'de sabit kategori zorunlu", () => {
    const d = selectSemanticStrategy(input({ category: explicit("giyim") }));
    expect(d).toMatchObject({
      strategy: "partial_hnsw",
      indexId: partialGiyim.id,
      efSearch: 400,
      categoryMode: "hard",
      requiresCategoryLiteral: true,
      degraded: false,
    });
  });

  it("acik orta alt kategori (1.975 <= 2.000) -> B-tree + kesin", () => {
    const d = selectSemanticStrategy(input({ category: explicit("giyim/ust-giyim") }));
    expect(d).toMatchObject({ strategy: "exact_btree", indexId: btree.id });
  });

  it("acik kucuk ve nadir kategori -> B-tree + kesin", () => {
    for (const path of ["giyim/ic-giyim", "giyim/tesettur-giyim"]) {
      expect(selectSemanticStrategy(input({ category: explicit(path) })).strategy).toBe(
        "exact_btree",
      );
    }
  });

  it("bos kategori -> ucuz kesin yol (0 sonuc), indeks taramasi yok", () => {
    const d = selectSemanticStrategy(input({ category: explicit("bos/kategori") }));
    expect(d.strategy).toBe("exact_btree");
    expect(d.reasons).toContain("kategori_bos");
  });

  it("buyuk kategori + kismi indeks yok -> global+filtre SECILMEZ, guvenli geri donus", () => {
    const stats = new Map([...STATS, stat("elektronik", 5095)]);
    const d = selectSemanticStrategy(
      input({ category: explicit("elektronik"), categoryStats: stats }),
    );
    expect(d.strategy).toBe("legacy_postfilter");
    expect(d.degraded).toBe(true);
    expect(d.reasons).toContain("buyuk_kategori_kismi_indeks_yok");
  });

  it("buyuk kategori: dogrulanmis kismi binary izinliyse secilir", () => {
    const stats = new Map([...STATS, stat("elektronik", 5095)]);
    const bin: IndexDescriptor = {
      ...binary,
      id: "pte_d1024_bin_elektronik",
      scope: { type: "category_top", value: "elektronik" },
    };
    const d = selectSemanticStrategy(
      input({
        category: explicit("elektronik"),
        categoryStats: stats,
        inventory: [bin, btree],
        config: { allowBinary: true },
      }),
    );
    expect(d).toMatchObject({ strategy: "binary_rerank", requiresCategoryLiteral: true });
  });
});

describe("esik sinirlari", () => {
  const at = (rows: number) =>
    selectSemanticStrategy(
      input({
        category: explicit("giyim/ust-giyim"),
        categoryStats: new Map([stat("giyim/ust-giyim", rows)]),
      }),
    ).strategy;

  it("tam esikte kesin, bir fazlasinda kismi HNSW", () => {
    expect(at(2000)).toBe("exact_btree");
    expect(at(2001)).toBe("partial_hnsw");
  });

  it("esik yapilandirilabilir", () => {
    const d = selectSemanticStrategy(
      input({ category: explicit("giyim/ust-giyim"), config: { exactMaxRows: 1000 } }),
    );
    expect(d.strategy).toBe("partial_hnsw");
  });

  it("gecersiz yapilandirma reddedilir", () => {
    expect(() => resolveStrategyConfig({ exactMaxRows: 0 })).toThrow(RangeError);
    expect(() => resolveStrategyConfig({ efSearchPartial: 5000 })).toThrow(RangeError);
    expect(() => resolveStrategyConfig({ efSearchGlobal: 1.5 })).toThrow(RangeError);
    expect(resolveStrategyConfig()).toEqual(DEFAULT_STRATEGY_CONFIG);
  });
});

describe("indeks envanteri sorunlari", () => {
  it("hazir olmayan kismi indeks kullanilmaz", () => {
    const building = { ...partialGiyim, state: "building" as const };
    const d = selectSemanticStrategy(
      input({ category: explicit("giyim"), inventory: [global, building, btree] }),
    );
    expect(d.strategy).toBe("legacy_postfilter");
    expect(d.reasons).toContain(`indeks_hazir_degil:${partialGiyim.id}`);
  });

  it("yanlis modele ya da surume ait kismi indeks kullanilmaz", () => {
    const wrongModel = { ...partialGiyim, modelVersion: "qwen3-embedding-0.6b-97b0c614" };
    const wrongVersion = { ...partialGiyim, indexVersion: "hnsw-m24-v2" };
    for (const bad of [wrongModel, wrongVersion]) {
      const d = selectSemanticStrategy(
        input({ category: explicit("giyim"), inventory: [global, bad, btree] }),
      );
      expect(d.strategy).toBe("legacy_postfilter");
    }
  });

  it("ust kategori indeksi alt kategori filtresine otomatik uygulanmaz (olculmedi)", () => {
    const stats = new Map([stat("giyim/ust-giyim", 5000)]);
    const d = selectSemanticStrategy(
      input({
        category: explicit("giyim/ust-giyim"),
        categoryStats: stats,
        inventory: [global, partialGiyim, btree],
      }),
    );
    expect(d.strategy).toBe("legacy_postfilter");
  });

  it("guvensiz kapsam degeri olan indeks envanterden elenir", () => {
    const evil: IndexDescriptor = {
      ...partialGiyim,
      id: "x",
      scope: { type: "category_top", value: "giyim'; DROP TABLE product; --" },
    };
    const d = selectSemanticStrategy(input({ inventory: [evil] }));
    expect(d.reasons).toContain("guvensiz_kapsam:x");
  });

  it("kucuk kategori ama B-tree yok -> varsa kismi indeks, yoksa geri donus", () => {
    const withPartial = selectSemanticStrategy(
      input({ category: explicit("giyim/ust-giyim"), inventory: [global, partialUst] }),
    );
    expect(withPartial.strategy).toBe("partial_hnsw");
    const none = selectSemanticStrategy(
      input({ category: explicit("giyim/ic-giyim"), inventory: [global] }),
    );
    expect(none.strategy).toBe("legacy_postfilter");
  });
});

describe("istatistik sorunlari", () => {
  it("istatistik yoksa: kismi indeks varsa o, yoksa geri donus (kesin secilmez)", () => {
    const d1 = selectSemanticStrategy(input({ category: explicit("giyim"), categoryStats: null }));
    expect(d1.strategy).toBe("partial_hnsw");
    expect(d1.reasons).toContain("kategori_istatistigi_yok");
    const d2 = selectSemanticStrategy(
      input({ category: explicit("giyim/ic-giyim"), categoryStats: null }),
    );
    expect(d2.strategy).toBe("legacy_postfilter");
  });

  it("eski istatistik kullanilmaz", () => {
    const old = new Map([stat("giyim/ic-giyim", 676, DEFAULT_STRATEGY_CONFIG.statsMaxAgeMs + 1)]);
    const d = selectSemanticStrategy(
      input({ category: explicit("giyim/ic-giyim"), categoryStats: old }),
    );
    expect(d.strategy).toBe("legacy_postfilter");
    expect(d.reasons).toContain("kategori_istatistigi_eski_ya_da_gecersiz");
  });

  it("gecersiz istatistik (negatif, kesirli, gelecek tarih, NaN tarih) kullanilmaz", () => {
    const bad: CategoryStat[] = [
      { path: "giyim/ic-giyim", rows: -1, computedAt: NOW },
      { path: "giyim/ic-giyim", rows: 1.5, computedAt: NOW },
      { path: "giyim/ic-giyim", rows: 10, computedAt: new Date(NOW.getTime() + 60_000) },
      { path: "giyim/ic-giyim", rows: 10, computedAt: new Date(Number.NaN) },
    ];
    for (const s of bad) {
      const d = selectSemanticStrategy(
        input({ category: explicit("giyim/ic-giyim"), categoryStats: new Map([[s.path, s]]) }),
      );
      expect(d.strategy).toBe("legacy_postfilter");
    }
  });
});

describe("kategorisiz urun politikasi", () => {
  it("acik kategori: kategorisiz urunler gosterilmez", () => {
    expect(selectSemanticStrategy(input({ category: explicit("giyim") })).uncategorized).toBe(
      "excluded",
    );
  });

  it("tahmin edilen kategori: kontrollu ikincil aday kaynagi (yapilandirilabilir)", () => {
    expect(selectSemanticStrategy(input({ category: inferred("giyim") })).uncategorized).toBe(
      "secondary_candidates",
    );
    const off = selectSemanticStrategy(
      input({ category: inferred("giyim"), config: { uncategorizedAsSecondary: false } }),
    );
    expect(off.uncategorized).toBe("included");
  });

  it("kategori yok: kategorisiz urunler normal adaydir", () => {
    expect(selectSemanticStrategy(input()).uncategorized).toBe("included");
  });
});

describe("kategori yolu guvenligi", () => {
  it("yalniz kucuk harf, rakam, tire ve egik cizgi", () => {
    expect(isSafeCategoryLiteral("giyim/ust-giyim")).toBe(true);
    expect(isSafeCategoryLiteral("bahce-elektrikli-el-aletleri/bahce")).toBe(true);
    for (const bad of ["", "Giyim", "giyim/", "/giyim", "giyim//x", "a'b", "a b", "x;--", "ğ"]) {
      expect(isSafeCategoryLiteral(bad), bad).toBe(false);
    }
  });

  it("gecersiz kategori yolu hicbir indeksle eslesmez", () => {
    const d = selectSemanticStrategy(input({ category: explicit("giyim'; --") }));
    expect(d).toMatchObject({ strategy: "legacy_postfilter", categoryPath: null });
    expect(d.reasons).toContain("gecersiz_kategori_yolu");
  });
});
