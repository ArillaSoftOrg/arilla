/**
 * Varyant duyarli fiyat karsilastirmasi (docs/decisions/0033).
 *
 * Urun renk duzeyinde kanonik; beden/hacim ise varyanttir (0005). Ayni urunun
 * teklifleri bu yuzden farkli ticari varyantlari satabilir: Korendy 60 ml ve
 * 100 ml'yi tek offer'da, Vionine 100 ml'yi ayri bir listede. Eski sayfa
 * `offer.current_price` (offer'in EN UCUZ varyanti) ile siraliyor ve
 * Korendy'nin 60 ml fiyatini Vionine'in 100 ml fiyatinin "en uygun" alternatifi
 * gibi gosteriyordu.
 *
 * Kural: iki fiyat yalnizca AYNI ticari varyanti satiyorsa dogrudan
 * karsilastirilir. Varyant anahtari:
 * - hacim/agirlik + paket adedi (etiketten ya da tek hacimli basliktan,
 *   `parseQuantity`): "60ml", "2x100ml", "20g";
 * - yoksa beden (`offer_variant.size_norm`): "beden:42", "beden:m".
 * Anahtari cikarilamayan teklif hicbir secili varyantla karsilastirilmaz.
 * Fiyat hic tahmin kaynagi degildir.
 */

export type QuantityUnit = "ml" | "g";

export interface Quantity {
  amount: number;
  unit: QuantityUnit;
  /** Paket adedi: "2 x 100 ml" -> 2. Tek urunde 1. */
  pack: number;
}

const UNIT_FACTORS: Record<string, { unit: QuantityUnit; factor: number }> = {
  ml: { unit: "ml", factor: 1 },
  cl: { unit: "ml", factor: 10 },
  l: { unit: "ml", factor: 1000 },
  lt: { unit: "ml", factor: 1000 },
  litre: { unit: "ml", factor: 1000 },
  g: { unit: "g", factor: 1 },
  gr: { unit: "g", factor: 1 },
  kg: { unit: "g", factor: 1000 },
};

const UNIT = "(ml|cl|lt|litre|l|kg|gr|g)";
/** "2 x 100 ml", "2x100ml", "2 × 50 g" */
const PACK_WITH_AMOUNT = new RegExp(
  `(?<![\\d.,])(\\d{1,2})\\s*[x×]\\s*(\\d+(?:[.,]\\d+)?)\\s*${UNIT}(?![\\p{L}])`,
  "giu",
);
const AMOUNT = new RegExp(`(?<![\\d.,])(\\d+(?:[.,]\\d+)?)\\s*${UNIT}(?![\\p{L}])`, "giu");
/** "2'li", "3'lü", "2li paket" — ADET bilgisi; hacimle birlikte paket sayilir. */
const PACK_WORD = /(?<![\d.,])(\d{1,2})\s*'?\s*(?:li|lı|lu|lü)(?![\p{L}])/iu;

function toQuantity(rawAmount: string, rawUnit: string, pack: number): Quantity | null {
  const spec = UNIT_FACTORS[rawUnit.toLocaleLowerCase("tr-TR")];
  const amount = Number(rawAmount.replace(",", "."));
  if (!spec || !Number.isFinite(amount) || amount <= 0) return null;
  // Kayan nokta gurultusu: 0.47 l -> 470 ml.
  return { amount: Math.round(amount * spec.factor * 1000) / 1000, unit: spec.unit, pack };
}

function sameQuantity(a: Quantity, b: Quantity): boolean {
  return a.amount === b.amount && a.unit === b.unit && a.pack === b.pack;
}

/**
 * Metindeki TEK ticari miktar. Birden fazla FARKLI miktar ("50 ml + 15 ml
 * set", "30 ml / 50 ml") belirsizdir: null. Birimsiz sayi ("345 Relief",
 * "No.9") hic miktar sayilmaz.
 */
export function parseQuantity(text: string | null | undefined): Quantity | null {
  if (!text) return null;
  const found: Quantity[] = [];
  const packed = [...text.matchAll(PACK_WITH_AMOUNT)];
  let rest = text;
  for (const match of packed) {
    const quantity = toQuantity(match[2] ?? "", match[3] ?? "", Number(match[1]));
    if (quantity) found.push(quantity);
    rest = rest.replace(match[0], " ");
  }
  const packWord = PACK_WORD.exec(rest);
  const pack = packWord ? Number(packWord[1]) : 1;
  for (const match of rest.matchAll(AMOUNT)) {
    const quantity = toQuantity(match[1] ?? "", match[2] ?? "", pack);
    if (quantity) found.push(quantity);
  }
  const first = found[0];
  if (!first) return null;
  return found.every((quantity) => sameQuantity(quantity, first)) ? first : null;
}

function formatAmount(amount: number): string {
  return Number.isInteger(amount)
    ? String(amount)
    : amount.toLocaleString("tr-TR", { maximumFractionDigits: 3 });
}

export function quantityKey(quantity: Quantity): string {
  return `${quantity.pack > 1 ? `${quantity.pack}x` : ""}${formatAmount(quantity.amount).replace(",", ".")}${quantity.unit}`;
}

export function quantityLabel(quantity: Quantity): string {
  return `${quantity.pack > 1 ? `${quantity.pack} x ` : ""}${formatAmount(quantity.amount)} ${quantity.unit}`;
}

/**
 * 100 ml / 100 g basina fiyat (kurus). Yalnizca miktar guvenle
 * ayristirilmissa; para birimi tum katalogda TRY (0029).
 */
export function unitPriceKurus(priceKurus: number, quantity: Quantity | null): number | null {
  if (!quantity) return null;
  const total = quantity.amount * quantity.pack;
  if (total <= 0) return null;
  return Math.round((priceKurus * 100) / total);
}

// ---------------------------------------------------------------------------

export interface VariantInput {
  /** `offer_variant.size_label` ya da (varyant satiri yoksa) teklif basligi. */
  label: string | null;
  sizeNorm: string | null;
  priceKurus: number;
  inStock: boolean;
  /** true: etiket bir varyant satirindan; false: teklifin kendi basligindan. */
  fromVariantRow: boolean;
}

export interface OfferInput {
  offerId: number;
  merchantName: string;
  merchantTrustScore: number;
  currentPrice: number;
  listPrice: number | null;
  shippingCost: number | null;
  freeShippingThreshold: number | null;
  inStock: boolean;
  variants: readonly VariantInput[];
}

export interface VariantKeyInfo {
  key: string;
  label: string;
  quantity: Quantity | null;
}

/** Varyantin karsilastirma anahtari; cikarilamiyorsa null. */
export function variantKey(variant: VariantInput): VariantKeyInfo | null {
  const quantity = parseQuantity(variant.label);
  if (quantity) {
    return { key: quantityKey(quantity), label: quantityLabel(quantity), quantity };
  }
  if (variant.fromVariantRow && variant.sizeNorm) {
    return {
      key: `beden:${variant.sizeNorm}`,
      label: variant.label?.trim() || variant.sizeNorm,
      quantity: null,
    };
  }
  return null;
}

export interface ComparisonRow {
  /** Satir kimligi: ayni teklif birden fazla varyantla listelenebilir. */
  rowKey: string;
  offerId: number;
  merchantName: string;
  merchantTrustScore: number;
  variantKey: string | null;
  variantLabel: string | null;
  priceKurus: number;
  /** Yalnizca bu varyantin liste fiyati bilindiginde (aksi halde null). */
  listPriceKurus: number | null;
  effectiveShipping: number;
  effectiveTotal: number;
  inStock: boolean;
  /** 100 ml / 100 g basina; guvenilir miktar yoksa null. */
  unitPriceKurus: number | null;
  unitLabel: string | null;
}

export interface VariantOption {
  key: string;
  label: string;
  /** Stoktaki uyumlu tekliflerin en dusugu; hic stok yoksa tum uyumlularin. */
  minPriceKurus: number;
  inStock: boolean;
  offerCount: number;
}

export type PriceComparison =
  | {
      /** Varyant fiyati etkilemiyor: eski davranis (offer basina bir satir). */
      mode: "simple";
    }
  | {
      mode: "variants";
      options: VariantOption[];
      /** Gecerli secim; secim yoksa ya da bilinmiyorsa null. */
      selectedKey: string | null;
      /** Istenen varyant hicbir teklifte yok. */
      selectedMissing: boolean;
      /** Seciliyse yalnizca uyumlu satirlar; degilse tum satirlar (notr). */
      rows: ComparisonRow[];
      /** Yalnizca secim varken: stoktaki en uygun uyumlu satir, yoksa en uygun uyumlu. */
      best: ComparisonRow | null;
      /** Tum varyantlarin en dusuk fiyati: "Başlangıç fiyatı". */
      startingPriceKurus: number;
    };

function shippingFor(offer: OfferInput, priceKurus: number): number {
  if (offer.freeShippingThreshold !== null && priceKurus >= offer.freeShippingThreshold) return 0;
  return offer.shippingCost ?? 0;
}

function listPriceFor(offer: OfferInput, variant: VariantInput): number | null {
  // Liste fiyati offer duzeyinde ve TEMSILCI (en ucuz) varyanttan gelir;
  // baska bir boyuta uygulanirsa sahte "tasarruf" uretir.
  if (offer.listPrice === null || variant.priceKurus !== offer.currentPrice) return null;
  const samePrice = offer.variants.filter((v) => v.priceKurus === offer.currentPrice).length;
  return samePrice <= 1 ? offer.listPrice : null;
}

function optionOrder(a: VariantKeyInfo, b: VariantKeyInfo): number {
  if (a.quantity && b.quantity) {
    if (a.quantity.unit !== b.quantity.unit) return a.quantity.unit.localeCompare(b.quantity.unit);
    return a.quantity.amount * a.quantity.pack - b.quantity.amount * b.quantity.pack;
  }
  if (a.quantity) return -1;
  if (b.quantity) return 1;
  const numA = Number(a.key.slice("beden:".length));
  const numB = Number(b.key.slice("beden:".length));
  if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB;
  return a.label.localeCompare(b.label, "tr");
}

export function buildPriceComparison(
  offers: readonly OfferInput[],
  requestedKey: string | null,
): PriceComparison {
  const rows: (ComparisonRow & { info: VariantKeyInfo | null })[] = [];
  const keySets: string[] = [];
  let pricesDifferWithinOffer = false;

  for (const offer of offers) {
    const variants: VariantInput[] =
      offer.variants.length > 0
        ? [...offer.variants]
        : [
            {
              label: null,
              sizeNorm: null,
              priceKurus: offer.currentPrice,
              inStock: offer.inStock,
              fromVariantRow: false,
            },
          ];
    const keys = new Set<string>();
    const prices = new Set<number>();
    for (const [index, variant] of variants.entries()) {
      const info = variantKey(variant);
      if (info) keys.add(info.key);
      prices.add(variant.priceKurus);
      const shipping = shippingFor(offer, variant.priceKurus);
      const unit = unitPriceKurus(variant.priceKurus, info?.quantity ?? null);
      rows.push({
        info,
        rowKey: `${offer.offerId}:${info?.key ?? index}`,
        offerId: offer.offerId,
        merchantName: offer.merchantName,
        merchantTrustScore: offer.merchantTrustScore,
        variantKey: info?.key ?? null,
        variantLabel: info?.label ?? null,
        priceKurus: variant.priceKurus,
        listPriceKurus: listPriceFor(offer, variant),
        effectiveShipping: shipping,
        effectiveTotal: variant.priceKurus + shipping,
        inStock: variant.inStock,
        unitPriceKurus: unit,
        unitLabel: unit === null || !info?.quantity ? null : `100 ${info.quantity.unit}`,
      });
    }
    keySets.push([...keys].sort().join("|"));
    if (keys.size > 1 && prices.size > 1) pricesDifferWithinOffer = true;
  }

  const known = new Map<string, VariantKeyInfo>();
  for (const row of rows) if (row.info) known.set(row.info.key, row.info);

  // Varyant fiyati etkilemiyorsa (tek varyant, ya da tum teklifler ayni
  // varyant kumesini tek fiyatla satiyor) eski karsilastirma dogrudur.
  const setsDiffer = new Set(keySets).size > 1;
  const needsVariant = known.size >= 2 && (setsDiffer || pricesDifferWithinOffer);
  if (!needsVariant) return { mode: "simple" };

  const byTotal = (a: ComparisonRow, b: ComparisonRow) =>
    a.effectiveTotal - b.effectiveTotal ||
    b.merchantTrustScore - a.merchantTrustScore ||
    a.offerId - b.offerId;

  const options: VariantOption[] = [...known.values()].sort(optionOrder).map((info) => {
    const matching = rows.filter((row) => row.variantKey === info.key);
    // "...'den" fiyati stoktaki tekliften; stokta yoksa en dusuk fiyattan.
    const available = matching.filter((row) => row.inStock);
    const priced = available.length > 0 ? available : matching;
    return {
      key: info.key,
      label: info.label,
      minPriceKurus: Math.min(...priced.map((row) => row.priceKurus)),
      inStock: matching.some((row) => row.inStock),
      offerCount: new Set(matching.map((row) => row.offerId)).size,
    };
  });

  const selectedKey = requestedKey && known.has(requestedKey) ? requestedKey : null;
  const startingPriceKurus = Math.min(...rows.map((row) => row.priceKurus));
  const clean = (row: ComparisonRow & { info: unknown }): ComparisonRow => {
    const { info: _info, ...rest } = row;
    return rest;
  };

  if (selectedKey) {
    const compatible = rows
      .filter((row) => row.variantKey === selectedKey)
      .sort(byTotal)
      .map(clean);
    return {
      mode: "variants",
      options,
      selectedKey,
      selectedMissing: false,
      rows: compatible,
      best: compatible.find((row) => row.inStock) ?? compatible[0] ?? null,
      startingPriceKurus,
    };
  }

  const order = new Map(options.map((option, index) => [option.key, index]));
  const neutral = [...rows]
    .sort(
      (a, b) =>
        (order.get(a.variantKey ?? "") ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.variantKey ?? "") ?? Number.MAX_SAFE_INTEGER) || byTotal(a, b),
    )
    .map(clean);
  return {
    mode: "variants",
    options,
    selectedKey: null,
    selectedMissing: requestedKey !== null,
    rows: neutral,
    best: null,
    startingPriceKurus,
  };
}
