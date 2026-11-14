import { describe, expect, it } from "vitest";
import { foldForMatch } from "../text-match.ts";
import {
  accessoryTitleDemotionPattern,
  looksLikeAccessory,
  queryWantsAccessory,
  requiredColorPattern,
} from "./accessory-guard.ts";
import { fuseResults } from "./fusion.ts";

const item = (id: number, title: string) => ({ productId: id, title });
const sem = (id: number, title: string, similarity: number) => ({ ...item(id, title), similarity });

describe("aksesuar korumasi", () => {
  it("cihazin aksesuarini/yedek parcasini taniyip ana cihazi tanimaz", () => {
    expect(looksLikeAccessory("SZ Case for GTS 4 Waterproof Smartwatch Bumper")).toBe(true);
    expect(looksLikeAccessory("Replacement Battery 361-00108 for Garmin Vivoactive 3")).toBe(true);
    expect(looksLikeAccessory("Robot Vacuum Accessories Kit Roller Brush 4 Filters")).toBe(true);
    expect(looksLikeAccessory("Headphone storage bag portable Bluetooth headphone cable bag")).toBe(
      true,
    );
    expect(looksLikeAccessory("Wireless Bluetooth Over-Ear Headphones Foldable with Mic")).toBe(
      false,
    );
    expect(looksLikeAccessory("Smart Watch Men Women Bluetooth Call Fitness Tracker")).toBe(false);
  });

  it("aksesuar isteyen sorguda koruma uygulanmaz (TR/EN, ASCII klavye dahil)", () => {
    for (const q of [
      "telefon kılıfı",
      "kulaklik standi",
      "phone case",
      "kulaklık pedi",
      "araba",
      "otomobil",
    ]) {
      expect(queryWantsAccessory(q), q).toBe(true);
    }
    for (const q of [
      "akıllı saat",
      "süpürge",
      "kablosuz kulaklık",
      "gaming headset",
      "sırt çantası",
    ]) {
      expect(queryWantsAccessory(q), q).toBe(false);
    }
  });

  it("anlamsal-yalniz aksesuar fuzyona girmez; metin aksesuari asagi iner", () => {
    const gate = { minSimilarity: 0.1, maxGapFromBest: 1, maxSemanticOnly: 9 };
    const text = [item(1, "Case for Smart Watch"), item(2, "Smart Watch Men Bluetooth")];
    const fused = fuseResults(text, [sem(9, "Smart Watch Ultra", 0.9)], {
      gate,
      isAccessory: (i) => looksLikeAccessory(i.title),
    });
    expect(fused.map((entry) => entry.item.productId)).toEqual([9, 2, 1]);
  });
});

describe("acik renk zorunlulugu", () => {
  it("TR/EN renk sorgusu icin baslik deseni uretir; renksiz sorguda null", () => {
    const pattern = requiredColorPattern("kırmızı şort") as string;
    const re = new RegExp(pattern);
    expect(re.test("women summer red shorts")).toBe(true);
    expect(re.test("kirmizi sort")).toBe(true);
    expect(re.test("cherry print shorts")).toBe(false);
    expect(requiredColorPattern("şort")).toBeNull();
    expect(requiredColorPattern("red shorts")).not.toBeNull();
  });
});

describe("ürün türüne uymayan ve anlamsal olarak da benzemeyen metin sonucu", () => {
  const gate = { minSimilarity: 0.3, maxGapFromBest: 0.2, maxSemanticOnly: 5 };
  const mismatch = (i: { title: string }) => !/car/.test(i.title);

  it("iki işaret birlikteyse çıkarılır; vektörü olmayan ya da benzer olan kalır", () => {
    const text = [item(1, "Arab Prince Costume"), item(2, "Car Seat Cover"), item(3, "Arab Robe")];
    const fused = fuseResults(text, [], {
      gate,
      isTypeMismatch: mismatch,
      // 1: vektör var, benzemiyor -> çıkar; 2: tür uyuyor -> kal; 3: vektörü yok -> kal
      textSimilarity: new Map([
        [1, 0.1],
        [2, 0.5],
      ]),
    });
    expect(fused.map((entry) => entry.item.productId)).toEqual([2, 3]);
  });

  it("tür uymasa da anlamsal olarak benziyorsa kalır", () => {
    const fused = fuseResults([item(1, "Vehicle Cover")], [], {
      gate,
      isTypeMismatch: mismatch,
      textSimilarity: new Map([[1, 0.6]]),
    });
    expect(fused.map((entry) => entry.item.productId)).toEqual([1]);
  });
});

describe("accessoryTitleDemotionPattern (karar 0197)", () => {
  const demoted = (query: string, title: string): boolean => {
    const pattern = accessoryTitleDemotionPattern(query);
    return pattern !== null && new RegExp(pattern).test(foldForMatch(title));
  };

  it("ana cihaz sorgusunda aksesuar basligini isaretler, cihazi degil", () => {
    expect(demoted("iphone 15", "iPhone 15 Uyumlu Silikon Kılıf")).toBe(true);
    expect(demoted("iphone 15", "iPhone 15 Ekran Koruyucu Temperli Cam")).toBe(true);
    expect(demoted("iphone 15", "Apple iPhone 15 128 GB Siyah")).toBe(false);
    expect(demoted("robot süpürge", "Robot Süpürge Yedek Parça Fırça Seti")).toBe(true);
    expect(demoted("robot süpürge", "Xiaomi Robot Süpürge X10 5000 Pa")).toBe(false);
  });

  it("kullanici aksesuar istiyorsa hicbir sey uygulanmaz", () => {
    expect(accessoryTitleDemotionPattern("iphone 15 kılıf")).toBeNull();
    expect(accessoryTitleDemotionPattern("telefon şarj kablosu")).toBeNull();
    expect(accessoryTitleDemotionPattern("")).toBeNull();
  });

  it("dogrulanmis model rolu accessory/part kademeyi kapatir; main ve rolsuz acik sozu degistirmez", () => {
    expect(accessoryTitleDemotionPattern("iphone 15", "accessory")).toBeNull();
    expect(accessoryTitleDemotionPattern("iphone 15", "part")).toBeNull();
    expect(accessoryTitleDemotionPattern("iphone 15", "main")).not.toBeNull();
    expect(accessoryTitleDemotionPattern("iphone 15", null)).not.toBeNull();
    // Acik soz modelden once gelir: model "main" dese de "kilif" istenmistir.
    expect(accessoryTitleDemotionPattern("iphone 15 kılıf", "main")).toBeNull();
  });

  it("baska urun turlerinde ana urun olan basliklar demote edilmez (guneş kremi, kemer, canta...)", () => {
    expect(demoted("güneş kremi", "Nivea Güneş Koruyucu Krem SPF50")).toBe(false);
    expect(demoted("yüz kremi", "Skin Care Nemlendirici Krem")).toBe(false);
    expect(demoted("kemer", "Hakiki Deri Erkek Kemer Kayış")).toBe(false);
    expect(demoted("kalemlik", "Pencil Case Kalem Kutusu")).toBe(false);
    expect(demoted("kartlık", "Deri Card Holder Kartlık")).toBe(false);
    expect(demoted("çanta", "Kadın Omuz Çantası Strap Detaylı")).toBe(false);
    expect(demoted("saat", "Erkek Kol Saati Deri Kayış")).toBe(false);
    expect(demoted("iphone 15", "iPhone 15 Ekran Koruyucu Temperli Cam Ekran")).toBe(true);
    expect(demoted("iphone 15", "Apple iPhone 15 Silicone Case Clear")).toBe(true);
  });
});
