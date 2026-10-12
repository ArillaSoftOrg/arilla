/**
 * Fiyat gozlem modeli ve karsilastirma motoru (arastirma; 05 test protokolu T2/T3).
 *
 * Trendyol'da "fiyat" tek deger degildir (11 §1): satici fiyati, liste fiyati, tanimsiz
 * `priceSeenByCustomer`, buybox fiyati, urun sayfasi katmanlari ve sepet fiyati ayri seylerdir.
 * Bu modul her gozlemi ayri saklar ve iki fiyat turunun ESIT oldugu hipotezini YALNIZCA
 * ayni urun + ayni varyant + ayni satici + kisa zaman araliginda sinar. Farkin nedenini
 * (yuzde indirim, sabit tutar, kampanya etiketi) otomatik siniflandirir; aciklanamayan farki
 * "unexplained" olarak isaretler, asla esit varsaymaz.
 */

export type PriceKind =
  // Satici API'si (yetkili satici; GERCEK API yaniti ile henuz gozlenmedi)
  | "seller.salePrice"
  | "seller.listPrice"
  | "seller.priceSeenByCustomer"
  // Buybox API'si (yalnizca saticinin kendi barkodlari)
  | "buybox.price"
  | "buybox.second"
  | "buybox.third"
  // Gercek tarayicida urun sayfasi gomulu JSON'u
  | "page.selling"
  | "page.discounted"
  | "page.original"
  | "page.coupon"
  /** Sayfada gorunen "Sepette %X" sonrasi tutar. */
  | "page.basket"
  // Gercek tarayicida liste karti
  | "listing.current"
  | "listing.discounted"
  | "listing.original";

export type ObservationSource =
  | "seller-api"
  | "buybox-api"
  | "browser-product-page"
  | "browser-listing";

export interface PriceObservation {
  kind: PriceKind;
  contentId: string;
  /** Varyant barkodu (beden basina); bilinmiyorsa null. */
  barcode: string | null;
  /** Varyant degeri ("38,5", "Tek Ebat", "Siyah Titanyum 128 GB"); bilinmiyorsa null. */
  variant: string | null;
  /** Teklif saticisi; buybox 2./3. fiyatlarda anonim (null). */
  supplierId: string | null;
  priceKurus: number;
  currency: "TRY";
  /** ISO 8601, UTC. */
  observedAt: string;
  source: ObservationSource;
  /** Gozlem anindaki kampanya etiketleri (ornegin "kirmizi_kampanya_urunu", "Sepette %50 Indirim"). */
  tags?: readonly string[];
}

export interface EqualityHypothesis {
  id: string;
  left: PriceKind;
  right: PriceKind;
  /** Saticilar farkli olabilir mi? (buybox kazanani anonim olabilir) */
  allowAnonymousSupplier?: boolean;
  description: string;
}

/** 05 protokolundeki hipotezler; hicbiri dogrulanmis DEGILDIR. */
export const HYPOTHESES: readonly EqualityHypothesis[] = [
  {
    id: "H1",
    left: "seller.priceSeenByCustomer",
    right: "page.discounted",
    description: "priceSeenByCustomer = urun sayfasindaki indirimli fiyat",
  },
  {
    id: "H2",
    left: "seller.salePrice",
    right: "page.selling",
    description: "salePrice = urun sayfasindaki satis fiyati",
  },
  {
    id: "H3",
    left: "seller.listPrice",
    right: "page.original",
    description: "listPrice = urun sayfasindaki orijinal (ustu cizili) fiyat",
  },
  {
    id: "H5",
    left: "buybox.price",
    right: "page.discounted",
    allowAnonymousSupplier: true,
    description: "buyboxPrice = buybox kazananinin sayfadaki indirimli fiyati",
  },
  {
    id: "H7",
    left: "listing.discounted",
    right: "page.basket",
    description: "liste karti indirimli fiyati = sayfadaki sepet fiyati",
  },
];

export type Verdict =
  | { status: "equal" }
  | { status: "percent-discount"; percent: number }
  | { status: "fixed-discount"; amountKurus: number }
  | { status: "campaign-tagged"; tags: readonly string[] }
  | { status: "unexplained"; diffKurus: number }
  | {
      status: "not-comparable";
      reason: "variant-mismatch" | "variant-unknown" | "seller-mismatch" | "time-gap";
    };

const normVariant = (v: string) =>
  v.toLocaleLowerCase("tr-TR").replace(",", ".").replace(/\s+/g, " ").trim();

/** base * (100 - p)/100 = observed (+-1 kurus) olan tam sayi p (1..95); yoksa null. */
export function detectPercentDiscount(baseKurus: number, observedKurus: number): number | null {
  if (observedKurus >= baseKurus) return null;
  for (let p = 1; p <= 95; p++) {
    if (Math.abs(Math.round((baseKurus * (100 - p)) / 100) - observedKurus) <= 1) return p;
  }
  return null;
}

/** Fark yuvarlak bir TL tutari mi (100 TL'nin kati)? */
export function detectFixedDiscount(baseKurus: number, observedKurus: number): number | null {
  const d = baseKurus - observedKurus;
  return d > 0 && d % 10_000 === 0 ? d : null;
}

export interface CompareOptions {
  /** Iki gozlem arasindaki en buyuk zaman farki (varsayilan 5 dk). */
  maxSkewMs?: number;
}

/** Iki gozlemi karsilastirir: once karsilastirilabilirlik, sonra esitlik, sonra farkin nedeni. */
export function comparePair(
  left: PriceObservation,
  right: PriceObservation,
  opts: CompareOptions & { allowAnonymousSupplier?: boolean } = {},
): Verdict {
  const maxSkew = opts.maxSkewMs ?? 5 * 60_000;
  if (left.barcode && right.barcode) {
    if (left.barcode !== right.barcode)
      return { status: "not-comparable", reason: "variant-mismatch" };
  } else if (!left.variant || !right.variant) {
    // Varyant kimligi bir tarafta bilinmiyorsa (cok bedenli urunde hangi beden?) karsilastirilmaz.
    return { status: "not-comparable", reason: "variant-unknown" };
  } else if (normVariant(left.variant) !== normVariant(right.variant)) {
    return { status: "not-comparable", reason: "variant-mismatch" };
  }
  const anon = opts.allowAnonymousSupplier && (left.supplierId == null || right.supplierId == null);
  if (!anon && left.supplierId !== right.supplierId) {
    return { status: "not-comparable", reason: "seller-mismatch" };
  }
  if (Math.abs(Date.parse(left.observedAt) - Date.parse(right.observedAt)) > maxSkew) {
    return { status: "not-comparable", reason: "time-gap" };
  }
  if (left.priceKurus === right.priceKurus) return { status: "equal" };
  const [hi, lo] =
    left.priceKurus > right.priceKurus
      ? [left.priceKurus, right.priceKurus]
      : [right.priceKurus, left.priceKurus];
  const percent = detectPercentDiscount(hi, lo);
  if (percent != null) return { status: "percent-discount", percent };
  const fixed = detectFixedDiscount(hi, lo);
  if (fixed != null) return { status: "fixed-discount", amountKurus: fixed };
  const tags = [...(left.tags ?? []), ...(right.tags ?? [])];
  if (tags.length > 0) return { status: "campaign-tagged", tags };
  return { status: "unexplained", diffKurus: hi - lo };
}

export interface HypothesisResult {
  hypothesis: EqualityHypothesis;
  pairs: { left: PriceObservation; right: PriceObservation; verdict: Verdict }[];
  counts: Record<Verdict["status"], number>;
  /** Karsilastirilabilir ciftlerde esitlik orani; cift yoksa null (dogrulanmadi). */
  equalRate: number | null;
}

/** Tum hipotezleri ayni urun (contentId) uzerindeki gozlem ciftleriyle sinar. */
export function evaluateHypotheses(
  observations: readonly PriceObservation[],
  hypotheses: readonly EqualityHypothesis[] = HYPOTHESES,
  opts: CompareOptions = {},
): HypothesisResult[] {
  return hypotheses.map((h) => {
    const lefts = observations.filter((o) => o.kind === h.left);
    const rights = observations.filter((o) => o.kind === h.right);
    const pairs: HypothesisResult["pairs"] = [];
    for (const l of lefts) {
      for (const r of rights) {
        if (l.contentId !== r.contentId) continue;
        pairs.push({
          left: l,
          right: r,
          verdict: comparePair(l, r, { ...opts, allowAnonymousSupplier: h.allowAnonymousSupplier }),
        });
      }
    }
    const counts = {
      equal: 0,
      "percent-discount": 0,
      "fixed-discount": 0,
      "campaign-tagged": 0,
      unexplained: 0,
      "not-comparable": 0,
    } satisfies Record<Verdict["status"], number>;
    for (const p of pairs) counts[p.verdict.status]++;
    const comparable = pairs.length - counts["not-comparable"];
    return {
      hypothesis: h,
      pairs,
      counts,
      equalRate: comparable > 0 ? counts.equal / comparable : null,
    };
  });
}
