/**
 * Arama niyeti: yama birlestirme, saklanan niyetin dogrulanmasi ve arayuz
 * etiketleri (docs/decisions/0074). Saf fonksiyonlar; DB, ag, model yok.
 *
 * Birlestirme sunucudadir ve deterministiktir: model "onceki niyeti koru, sunu
 * degistir" yamasi dondurur, sonucu burasi hesaplar. Boylece "daha ucuz",
 * "siyah olsun", "Nike olsun", "2500 TL altı" onceki aramayi sifirlamaz.
 */
import {
  CHAT_LIMITS,
  cleanText,
  type RemovableField,
  type SearchIntent,
  type SearchIntentPatch,
} from "./contract.ts";

export function emptyIntent(query: string): SearchIntent {
  return {
    query,
    category: null,
    brand: null,
    excludeBrands: [],
    colors: [],
    size: null,
    priceMin: null,
    priceMax: null,
    attributes: {},
    sort: null,
  };
}

function clearField(intent: SearchIntent, field: RemovableField): void {
  switch (field) {
    case "category":
    case "brand":
    case "size":
    case "priceMin":
    case "priceMax":
    case "sort":
      intent[field] = null;
      return;
    case "excludeBrands":
    case "colors":
      intent[field] = [];
      return;
    case "attributes":
      intent.attributes = {};
      return;
  }
}

/** Alt sinir ust siniri asarsa yamanin DOKUNMADIGI taraf dusurulur (yeni beyan kazanir). */
function reconcilePrices(intent: SearchIntent, patch: SearchIntentPatch): void {
  const { priceMin, priceMax } = intent;
  if (priceMin === null || priceMax === null || priceMin <= priceMax) return;
  if (patch.priceMax !== undefined && patch.priceMin === undefined) intent.priceMin = null;
  else if (patch.priceMin !== undefined && patch.priceMax === undefined) intent.priceMax = null;
  else intent.priceMin = null;
}

/**
 * `current` + `patch` -> yeni niyet. Sorgu metni yoksa (ilk arama ya da `reset`
 * ve yamada `query` yok) birlestirilemez: `null` doner, cagiran yedek yola gider.
 */
export function mergeSearchIntent(
  current: SearchIntent | null,
  patch: SearchIntentPatch,
): SearchIntent | null {
  const base = patch.reset || current === null ? null : current;
  const query = (patch.query ?? base?.query)?.trim();
  if (!query) return null;

  const next: SearchIntent = base
    ? {
        ...base,
        excludeBrands: [...base.excludeBrands],
        colors: [...base.colors],
        attributes: { ...base.attributes },
      }
    : emptyIntent(query);
  next.query = query;

  for (const field of patch.remove) clearField(next, field);

  if (patch.category !== undefined) next.category = patch.category;
  if (patch.brand !== undefined) {
    next.brand = patch.brand;
    // Ayni marka hem istenip hem dislanamaz: yeni beyan kazanir.
    next.excludeBrands = next.excludeBrands.filter(
      (b) => b.toLowerCase() !== patch.brand?.toLowerCase(),
    );
  }
  if (patch.excludeBrands !== undefined) {
    for (const brand of patch.excludeBrands) {
      if (!next.excludeBrands.some((b) => b.toLowerCase() === brand.toLowerCase())) {
        next.excludeBrands.push(brand);
      }
    }
    next.excludeBrands = next.excludeBrands.slice(0, CHAT_LIMITS.maxList);
    if (
      next.brand &&
      next.excludeBrands.some((b) => b.toLowerCase() === next.brand?.toLowerCase())
    ) {
      next.brand = null;
    }
  }
  if (patch.colors !== undefined) next.colors = patch.colors;
  if (patch.size !== undefined) next.size = patch.size;
  if (patch.priceMin !== undefined) next.priceMin = patch.priceMin;
  if (patch.priceMax !== undefined) next.priceMax = patch.priceMax;
  if (patch.attributes !== undefined) {
    next.attributes = { ...next.attributes, ...patch.attributes };
  }
  if (patch.sort !== undefined) next.sort = patch.sort;

  reconcilePrices(next, patch);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown, max: number): string | null {
  return cleanText(value, max);
}

function priceOrNull(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= CHAT_LIMITS.maxPriceTry
    ? value
    : null;
}

/**
 * Veritabanindan okunan niyeti dogrular. Sema degisse ya da satir elle bozulsa
 * bile sayfa cokmez: gecersizse `null` (niyet yokmus gibi davranilir).
 */
export function parseStoredIntent(raw: unknown): SearchIntent | null {
  if (!isRecord(raw)) return null;
  const query = textOrNull(raw.query, CHAT_LIMITS.queryChars);
  if (query === null) return null;
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((item) => textOrNull(item, CHAT_LIMITS.shortText))
          .filter((item): item is string => item !== null)
          .slice(0, CHAT_LIMITS.maxList)
      : [];
  const attributes: Record<string, string> = {};
  if (isRecord(raw.attributes)) {
    for (const [key, value] of Object.entries(raw.attributes)) {
      const k = textOrNull(key, CHAT_LIMITS.questionId);
      const v = textOrNull(value, CHAT_LIMITS.shortText);
      if (k !== null && v !== null && Object.keys(attributes).length < CHAT_LIMITS.maxAttributes) {
        attributes[k] = v;
      }
    }
  }
  return {
    query,
    category: textOrNull(raw.category, CHAT_LIMITS.shortText),
    brand: textOrNull(raw.brand, CHAT_LIMITS.shortText),
    excludeBrands: list(raw.excludeBrands),
    colors: list(raw.colors),
    size: textOrNull(raw.size, CHAT_LIMITS.shortText),
    priceMin: priceOrNull(raw.priceMin),
    priceMax: priceOrNull(raw.priceMax),
    attributes,
    sort: raw.sort === "cheapest" || raw.sort === "balanced" ? raw.sort : null,
  };
}

export interface IntentChip {
  /** Kararli anahtar (React key ve test icin). */
  key: string;
  label: string;
}

function formatTry(value: number): string {
  return `${value.toLocaleString("tr-TR")} TL`;
}

/**
 * Anlasilan niyetin arayuz cipleri. Metinler arayuz dilinde: ALL CAPS yok,
 * yasakli kelime yok ("ucuz" yerine "fiyata göre", docs/glossary.md).
 */
export function intentChips(intent: SearchIntent): IntentChip[] {
  const chips: IntentChip[] = [{ key: "query", label: intent.query }];
  if (intent.category) chips.push({ key: "category", label: intent.category });
  if (intent.brand) chips.push({ key: "brand", label: `Marka: ${intent.brand}` });
  for (const brand of intent.excludeBrands) {
    chips.push({ key: `exclude:${brand}`, label: `${brand} hariç` });
  }
  if (intent.colors.length > 0) chips.push({ key: "colors", label: intent.colors.join(", ") });
  if (intent.size) chips.push({ key: "size", label: `Beden: ${intent.size}` });
  if (intent.priceMin !== null && intent.priceMax !== null) {
    chips.push({
      key: "price",
      label: `${formatTry(intent.priceMin)} - ${formatTry(intent.priceMax)}`,
    });
  } else if (intent.priceMax !== null) {
    chips.push({ key: "price", label: `En fazla ${formatTry(intent.priceMax)}` });
  } else if (intent.priceMin !== null) {
    chips.push({ key: "price", label: `En az ${formatTry(intent.priceMin)}` });
  }
  for (const [key, value] of Object.entries(intent.attributes)) {
    chips.push({ key: `attr:${key}`, label: value });
  }
  if (intent.sort === "cheapest") chips.push({ key: "sort", label: "Fiyata göre" });
  return chips;
}
