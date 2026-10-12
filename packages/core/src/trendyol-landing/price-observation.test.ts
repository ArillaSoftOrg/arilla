import { describe, expect, it } from "vitest";

import {
  comparePair,
  detectFixedDiscount,
  detectPercentDiscount,
  evaluateHypotheses,
  type PriceObservation,
} from "./price-observation.ts";
import { REFERENCE_OBSERVATIONS as REF } from "./reference-observations.ts";

const find = (kind: PriceObservation["kind"], contentId: string, variant?: string | null) => {
  const o = REF.find(
    (r) =>
      r.kind === kind &&
      r.contentId === contentId &&
      (variant === undefined || r.variant === variant),
  );
  if (!o) throw new Error(`referans yok: ${kind} ${contentId}`);
  return o;
};

// Bu fonksiyonlar yalnizca ARITMETIK uyumu bulur; bir kampanyanin/sepet indiriminin
// uygulandigini kanitlamaz (o bilgi ancak sayfadaki etiket ya da yetkili kaynakla gelir).
describe("aritmetik uyum dedektorleri (gercek gozlemlenen fiyatlar)", () => {
  it("Samba liste karti: 7.999 -> 3.999,50 = 7.999 x %50", () => {
    expect(detectPercentDiscount(799_900, 399_950)).toBe(50);
  });
  it("Samba 38,5 sayfa: 7.199 -> 5.399,25 (%25); 7.199 -> 5.687,21 (%21)", () => {
    expect(detectPercentDiscount(719_900, 539_925)).toBe(25);
    expect(detectPercentDiscount(719_900, 568_721)).toBe(21);
  });
  it("iPhone: 127.999 -> 124.999 tam yuzde degil; fark 3.000 TL (yuvarlak tutar)", () => {
    expect(detectPercentDiscount(12_799_900, 12_499_900)).toBeNull();
    expect(detectFixedDiscount(12_799_900, 12_499_900)).toBe(300_000);
  });
});

describe("comparePair: yanlis eslesmeyi engeller", () => {
  it("varyant bilinmiyorsa karsilastirmaz (Samba varsayilan beden vs 38,5)", () => {
    const def = REF.find(
      (r) => r.contentId === "813659620" && r.variant === null && r.kind === "page.discounted",
    );
    expect(
      comparePair(def as PriceObservation, find("page.discounted", "813659620", "38,5")),
    ).toEqual({
      status: "not-comparable",
      reason: "variant-unknown",
    });
  });
  it("farkli zamanlari esit saymaz (iPhone liste 23:12 vs sayfa 23:23)", () => {
    expect(
      comparePair(find("listing.discounted", "857296094"), find("page.discounted", "857296094")),
    ).toEqual({
      status: "not-comparable",
      reason: "time-gap",
    });
    // Ayni ciftte daha genis pencere secilirse esitler (124.999 = 124.999).
    expect(
      comparePair(find("listing.discounted", "857296094"), find("page.discounted", "857296094"), {
        maxSkewMs: 15 * 60_000,
      }),
    ).toEqual({ status: "equal" });
  });
  it("farkli saticiyi karsilastirmaz", () => {
    const a = find("page.discounted", "857296094");
    expect(comparePair(a, { ...a, supplierId: "999" })).toMatchObject({
      reason: "seller-mismatch",
    });
  });
  it("farkli barkodu (beden) karsilastirmaz", () => {
    const a = find("page.discounted", "813659620", "38,5");
    expect(comparePair(a, { ...a, barcode: "4066765863348" })).toMatchObject({
      reason: "variant-mismatch",
    });
  });
  it("Samba liste 3.999,50 vs sayfa sepet 5.399,25 (28 sn arayla): 'differs'; kampanya sonucu cikarilmaz", () => {
    const v = comparePair(
      find("listing.discounted", "813659620", "38,5"),
      find("page.basket", "813659620", "38,5"),
    );
    expect(v).toMatchObject({
      status: "differs",
      diffKurus: 139_975,
      evidence: { arithmeticPercent: null, arithmeticFixedKurus: null, verified: false },
    });
    // Etiketler yalnizca gozlenen metin olarak tasinir.
    if (v.status === "differs") expect(v.evidence.observedTags).toContain("Sepette %25 İndirim");
  });
  it("aritmetik uyum olsa bile sonuc 'differs' + verified:false (iPhone liste 127.999 vs 124.999)", () => {
    const v = comparePair(
      find("listing.original", "857296094"),
      find("listing.discounted", "857296094"),
    );
    expect(v).toMatchObject({
      status: "differs",
      evidence: { arithmeticFixedKurus: 300_000, verified: false },
    });
  });
});

describe("evaluateHypotheses (referans set)", () => {
  const results = evaluateHypotheses(REF);
  it("satici/buybox API gozlemi olmadigi icin H1, H2, H3, H5 dogrulanmamis (cift yok)", () => {
    for (const id of ["H1", "H2", "H3", "H5"]) {
      const r = results.find((x) => x.hypothesis.id === id);
      expect(r?.pairs).toHaveLength(0);
      expect(r?.equalRate).toBeNull();
    }
  });
  it("H7 (liste indirimli = sayfa sepet) gercek veride esit cikmiyor", () => {
    const h7 = results.find((x) => x.hypothesis.id === "H7");
    expect(h7?.counts.equal).toBe(0);
    expect(h7?.pairs.length).toBeGreaterThan(0);
  });
  it("farkli content'ler (Sony 3 satici) eslestirilmez", () => {
    for (const r of results) {
      for (const p of r.pairs) expect(p.left.contentId).toBe(p.right.contentId);
    }
  });
});
