/**
 * Sohbet niyeti + merkezi kategori sozlugu (karar 0133). Fixture, siniflandirma isinin
 * `classify lexicon --apply` ile yazdigi satirlarin aynisidir (Python testi esitligi korur).
 * Model yalnizca niyet cikarir; kategoriyi katalog kimligine ceviren mevcut sozluktur.
 */
import { describe, expect, it } from "vitest";
import fixture from "../search/classification-lexicon.fixture.json" with { type: "json" };
import type { LexiconEntry } from "../search/lexicon.ts";
import { emptyIntent } from "./intent.ts";
import { intentToQueryObject } from "./search-adapter.ts";

const lexicon = fixture as LexiconEntry[];
const ask = (query: string, overrides = {}) =>
  intentToQueryObject({ ...emptyIntent(query), ...overrides }, lexicon);

describe("sohbet: merkezi kategori sozlugu", () => {
  it("kablosuz oyuncu kulaklığı -> oyuncu kulaklığı dalı, 'kablosuz' metin kosulu kalır", () => {
    const q = ask("kablosuz oyuncu kulaklığı");
    expect(q.filters.category_path).toBe("elektronik/ses/kulaklik/oyuncu");
  });

  it("kadın omuz çantası -> omuz çantaları", () => {
    expect(ask("kadın omuz çantası").filters.category_path).toBe("moda/canta/omuz-cantasi");
  });

  it("mutfak için kahve ekipmanları -> en derin kategori seçilir", () => {
    expect(ask("mutfak için kahve ekipmanları").filters.category_path).toBe(
      "ev-yasam/mutfak/kahve-ekipmanlari",
    );
  });

  it("Samsung telefon -> cep telefonu kategorisi; marka sözlükte zorunlu filtre yapılmaz", () => {
    const q = ask("samsung telefon", { brand: "Samsung", category: "telefon" });
    expect(q.filters.category_path).toBe("elektronik/telefon/cep-telefonu");
    // Marka katı filtre değildir: "Samsung uyumlu" aksesuarlar ve markasız ilanlar dışlanmaz;
    // marka eşleşmesi aday kapısında (brand_id ya da başlık) yapılır.
    expect(q.filters.brand_include).toBeUndefined();
  });

  it("Apple iPhone 16 için kılıf -> telefon kılıfı (uyumluluk metinde kalır)", () => {
    // Model niyetinde kategori verir; uyumlu cihaz ("iPhone 16") metin koşulu olarak kalır.
    const q = ask("Apple iPhone 16 kılıf", { category: "telefon kılıfı" });
    expect(q.filters.category_path).toBe("elektronik/telefon/aksesuar/kilif");
    expect(q.filters.brand_include).toBeUndefined();
    // Yalnız metinde, kelimelerin çoğu kategori değilse ayrıştırıcı katı filtre kurmaz.
    expect(ask("Apple iPhone 16 için kılıf").filters.category_path).toBeUndefined();
  });

  it("modelin serbest kategori metni de aynı sözlükten geçer", () => {
    const q = ask("rahat bir şey", { category: "spor ayakkabı" });
    expect(q.filters.category_path).toBe("moda/ayakkabi/spor-ayakkabi");
  });

  it("sözlükte olmayan kategori filtreye dönüşmez", () => {
    expect(ask("hediye", { category: "uzay gemisi" }).filters.category_path).toBeUndefined();
  });
});
