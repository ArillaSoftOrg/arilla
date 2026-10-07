/**
 * Katalog urun turleri (docs/decisions/0063). Anlik/saklanan model yorumunun
 * secebilecegi, MEVCUT katalog kategorilerine baglanan urun turleri.
 *
 * Neden ayri liste:
 * - Kategori agaci kurumsal bir karardir ve yalnizca migration'la degisir
 *   (0016; toplama isi kategori ACMAZ: `services/ingest/resolve/products.py`
 *   `resolve_category`). Uretimde ust kategoriler vardir (elektronik, ev-yasam,
 *   anne-bebek, kitap-muzik-hobi, spor-outdoor, oto-bahce, petshop,
 *   supermarket, saglik-kozmetik/kozmetik); "laptop" gibi alt kategori yoktur.
 *   Bu yuzden urun turu = mevcut kategori yolu + basliktaki bas isim.
 * - Deterministik tetikleyici YOK (`triggers: []`): kural sozlugunun ve
 *   bugunku deterministik aramanin davranisi degismez. Bu turleri yalnizca
 *   model secebilir; secim taksonomiye karsi dogrulanir (uydurma tur yok).
 * - Soru sorulmaz (`maxQuestions: 0`): tur secilince dogrudan aranir.
 *
 * Yeni tur eklemek: bu diziye TEK kayit. Kategori yolu uretimde var olmali
 * (yoksa arama bos sonuca duser ve genel geri dusus calisir). Bas ismin
 * basliklardaki es anlamlilari `alternatives`'e. Basliktan okunabilen bir
 * nitelik (ör. "gaming") yalnizca katalog basliklarinda gercekten geciyorsa
 * `qualifiers`'a eklenir; veride karsiligi olmayan nitelik (agirlik, RAM,
 * ekran boyutu) EKLENMEZ.
 */
import type { BudgetBand, DomainDefinition } from "./types.ts";

export interface CatalogProductType {
  id: string;
  label: string;
  /** Uretimde var olan `category.path`. */
  categoryPath: string;
  /** Basliktaki bas isim ve es anlamlilari (ilk eleman bas isimdir). */
  head: readonly [string, ...string[]];
  /** Basliktan okunan, aramayi daraltan niteleyiciler. */
  qualifiers?: readonly { id: string; label: string; terms: readonly string[] }[];
}

/** Genel butce bantlari: yalnizca modele "butce desteklenir" bilgisi verir; soru sorulmaz. */
const GENERIC_BUDGET_BANDS: readonly BudgetBand[] = [
  { id: "up_to_1000", label: "1.000 TL'ye kadar", minTry: null, maxTry: 1000 },
  { id: "1000_5000", label: "1.000 – 5.000 TL", minTry: 1000, maxTry: 5000 },
  { id: "5000_20000", label: "5.000 – 20.000 TL", minTry: 5000, maxTry: 20000 },
  { id: "over_20000", label: "20.000 TL ve üzeri", minTry: 20000, maxTry: null },
];

export const CATALOG_PRODUCT_TYPES: readonly CatalogProductType[] = [
  {
    id: "laptop",
    label: "Laptop / dizüstü bilgisayar",
    categoryPath: "elektronik",
    head: ["laptop", "notebook", "dizüstü"],
    qualifiers: [{ id: "gaming", label: "Oyun (gaming)", terms: ["gaming"] }],
  },
  { id: "tablet", label: "Tablet", categoryPath: "elektronik", head: ["tablet"] },
  { id: "monitor", label: "Monitör", categoryPath: "elektronik", head: ["monitör", "monitor"] },
  {
    id: "game_console",
    label: "Oyun konsolu",
    categoryPath: "elektronik",
    head: ["konsol", "playstation", "xbox", "nintendo"],
  },
  {
    id: "perfume",
    label: "Parfüm",
    categoryPath: "saglik-kozmetik/kozmetik",
    head: ["parfüm", "edp", "edt"],
  },
  {
    id: "stroller",
    label: "Bebek arabası",
    categoryPath: "anne-bebek",
    head: ["arabası", "puset"],
  },
  { id: "tent", label: "Kamp çadırı", categoryPath: "spor-outdoor", head: ["çadır"] },
  { id: "book", label: "Kitap", categoryPath: "kitap-muzik-hobi", head: ["kitap"] },
  { id: "vacuum", label: "Elektrikli süpürge", categoryPath: "ev-yasam", head: ["süpürge"] },
];

/** Tek kaydi alan tanimina cevirir; kayit disinda dosya duzenlemek gerekmez. */
export function productTypeDomain(type: CatalogProductType): DomainDefinition {
  const [head, ...alternatives] = type.head;
  const qualifiers = type.qualifiers ?? [];
  return {
    id: type.id,
    label: type.label,
    kind: "product",
    modelOnly: true,
    triggers: [],
    retrievalTerms: [head],
    retrievalAlternatives: alternatives,
    categoryPath: type.categoryPath,
    facets:
      qualifiers.length > 0
        ? [
            {
              id: `${type.id}_qualifier`,
              question: `${type.label} için öne çıkan özellik?`,
              // Her secenegin basliga dayali katkisi var (registry kurali).
              role: "filter" as const,
              skipLabel: "Fark etmez",
              options: qualifiers.map((q) => ({
                id: q.id,
                label: q.label,
                triggers: [],
                contribution: { terms: q.terms },
              })),
            },
          ]
        : [],
    questionOrder: [],
    budgetBands: GENERIC_BUDGET_BANDS,
    readyAfterSignals: 0,
    maxQuestions: 0,
  };
}

export const CATALOG_PRODUCT_TYPE_DOMAINS: readonly DomainDefinition[] =
  CATALOG_PRODUCT_TYPES.map(productTypeDomain);
