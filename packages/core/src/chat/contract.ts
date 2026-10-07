/**
 * Konusmali kesfin model sozlesmesi (docs/decisions/0074).
 *
 * Model ciktisi `unknown`dir; `parseModelTurn` gecmeden hicbir yere yazilmaz.
 * Iki eylem:
 * - `clarify`: tek soru + secenekler. `intent` yoktur.
 * - `search`: `SearchIntentPatch`. Model TAM niyeti degil YAMAYI dondurur; birlestirme
 *   sunucuda (`mergeSearchIntent`) deterministiktir.
 *
 * Model hicbir zaman urun, fiyat, stok, SQL ya da kimlik uretmez; `intent` yalnizca
 * kullanicinin soyledigi arama kisitlarini tasir ve katalog arama katmanindan gecer.
 *
 * Gemini `response_format` JSON Schema altkumesi sinirli oldugu icin sema duzdur
 * (nullable alanlar, `attributes` anahtar-deger LISTESI). Bu dosya hem semayi hem
 * ayni kurallari uygulayan dogrulayiciyi tasir; ikisi birlikte degisir.
 */

export const CHAT_LIMITS = {
  message: 400,
  queryChars: 120,
  shortText: 60,
  optionLabel: 60,
  optionDescription: 120,
  optionValue: 60,
  questionTitle: 160,
  questionId: 40,
  maxOptions: 6,
  minOptions: 2,
  maxList: 5,
  maxAttributes: 6,
  maxPriceTry: 10_000_000,
} as const;

/** Modelin kaldirabilecegi niyet alanlari. */
export const REMOVABLE_FIELDS = [
  "category",
  "brand",
  "excludeBrands",
  "colors",
  "size",
  "priceMin",
  "priceMax",
  "attributes",
  "sort",
] as const;
export type RemovableField = (typeof REMOVABLE_FIELDS)[number];

export type SortPreference = "cheapest" | "balanced";

/** Normalize edilmis, birlestirilmis arama niyeti. Fiyatlar TL (tam sayi); adapter kurusa cevirir. */
export interface SearchIntent {
  query: string;
  category: string | null;
  brand: string | null;
  excludeBrands: string[];
  colors: string[];
  size: string | null;
  priceMin: number | null;
  priceMax: number | null;
  attributes: Record<string, string>;
  sort: SortPreference | null;
}

/** Modelin dondurdugu yama: yalnizca verilen alanlar degisir. */
export interface SearchIntentPatch {
  /** true: onceki niyet atilir (yeni konu). */
  reset: boolean;
  /** true: tum kisitlar (marka, renk, fiyat...) temizlenir, sorgu metni kalir. */
  clear: boolean;
  query?: string;
  category?: string;
  brand?: string;
  excludeBrands?: string[];
  colors?: string[];
  size?: string;
  priceMin?: number;
  priceMax?: number;
  attributes?: Record<string, string>;
  sort?: SortPreference;
  remove: RemovableField[];
}

export interface ClarifyOption {
  label: string;
  description?: string;
  value: string;
}

export interface ClarifyQuestion {
  id: string;
  title: string;
  options: ClarifyOption[];
  allowCustomAnswer: boolean;
  skippable: boolean;
}

export type ModelTurn =
  | { action: "clarify"; message: string; question: ClarifyQuestion }
  | { action: "search"; message: string; intent: SearchIntentPatch };

export type ModelTurnRejection =
  | "not_object"
  | "bad_action"
  | "bad_message"
  | "bad_question"
  | "bad_intent";

export type ParsedModelTurn =
  | { ok: true; turn: ModelTurn }
  | { ok: false; reason: ModelTurnRejection };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Model ciktisinda baglanti/adres olamaz (urun ve link katalogdan gelir). */
const URL_RE = /(?:https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|tr|io|co)\b)/i;

/** Kontrol karakterleri ve cok bosluk atilir; ust sinirda kesilir. Bos kalirsa null. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  let text = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    text += code < 32 || code === 127 ? " " : char;
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > max ? text.slice(0, max).trimEnd() : text;
}

function cleanList(value: unknown, itemMax: number): string[] | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const text = cleanText(item, itemMax);
    if (text !== null && !out.includes(text)) out.push(text);
  }
  return out.slice(0, CHAT_LIMITS.maxList);
}

function cleanPrice(value: unknown): number | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return "invalid";
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > CHAT_LIMITS.maxPriceTry) return "invalid";
  return rounded;
}

/**
 * `attributes`: nesne ya da `[{key, value}]` listesi (Gemini semasi liste kullanir).
 * Sayi ve uzunluk siniri uygulanir.
 */
function cleanAttributes(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined) return {};
  const entries: [unknown, unknown][] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) return null;
      entries.push([item.key, item.value]);
    }
  } else if (isRecord(value)) {
    entries.push(...Object.entries(value));
  } else {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = cleanText(rawKey, CHAT_LIMITS.questionId);
    const val = cleanText(rawValue, CHAT_LIMITS.shortText);
    if (key === null || val === null) continue;
    out[key] = val;
    if (Object.keys(out).length >= CHAT_LIMITS.maxAttributes) break;
  }
  return out;
}

function parseIntentPatch(raw: unknown): SearchIntentPatch | null {
  if (!isRecord(raw)) return null;
  const patch: SearchIntentPatch = {
    reset: raw.reset === true,
    clear: raw.clear === true,
    remove: [],
  };

  if (raw.query !== null && raw.query !== undefined) {
    const query = cleanText(raw.query, CHAT_LIMITS.queryChars);
    if (query === null) return null;
    patch.query = query;
  }
  for (const key of ["category", "brand", "size"] as const) {
    const value = raw[key];
    if (value === null || value === undefined) continue;
    const text = cleanText(value, CHAT_LIMITS.shortText);
    if (text !== null) patch[key] = text;
  }
  const exclude = cleanList(raw.excludeBrands, CHAT_LIMITS.shortText);
  const colors = cleanList(raw.colors, CHAT_LIMITS.shortText);
  if (exclude === null || colors === null) return null;
  if (exclude.length > 0) patch.excludeBrands = exclude;
  if (colors.length > 0) patch.colors = colors;

  const min = cleanPrice(raw.priceMin);
  const max = cleanPrice(raw.priceMax);
  if (min === "invalid" || max === "invalid") return null;
  if (min !== null) patch.priceMin = min;
  if (max !== null) patch.priceMax = max;

  const attributes = cleanAttributes(raw.attributes);
  if (attributes === null) return null;
  if (Object.keys(attributes).length > 0) patch.attributes = attributes;

  if (raw.sort === "cheapest" || raw.sort === "balanced") patch.sort = raw.sort;
  else if (raw.sort !== null && raw.sort !== undefined) return null;

  if (raw.remove !== null && raw.remove !== undefined) {
    if (!Array.isArray(raw.remove)) return null;
    for (const item of raw.remove) {
      // Bilinmeyen alan adi sessizce atilir; model yeni alan uyduramaz.
      if (REMOVABLE_FIELDS.includes(item as RemovableField)) {
        patch.remove.push(item as RemovableField);
      }
    }
  }
  return patch;
}

/** Model ciktisindaki ve saklanan soruyu ayni kurallarla dogrular. */
export function parseClarifyQuestion(raw: unknown): ClarifyQuestion | null {
  if (!isRecord(raw)) return null;
  const id = cleanText(raw.id, CHAT_LIMITS.questionId);
  const title = cleanText(raw.title, CHAT_LIMITS.questionTitle);
  if (id === null || title === null || !Array.isArray(raw.options)) return null;

  const options: ClarifyOption[] = [];
  const seen = new Set<string>();
  for (const item of raw.options) {
    if (!isRecord(item)) return null;
    const label = cleanText(item.label, CHAT_LIMITS.optionLabel);
    const value = cleanText(item.value, CHAT_LIMITS.optionValue);
    if (label === null || value === null || seen.has(value)) return null;
    seen.add(value);
    const description = cleanText(item.description, CHAT_LIMITS.optionDescription);
    options.push(description === null ? { label, value } : { label, description, value });
  }
  if (options.length < CHAT_LIMITS.minOptions || options.length > CHAT_LIMITS.maxOptions) {
    return null;
  }
  return {
    id,
    title,
    options,
    // Kullanici hicbir zaman bir soruya hapsolmaz: model bunlari kapatamaz.
    allowCustomAnswer: true,
    skippable: true,
  };
}

/** Modelin ham ciktisini dogrular. Asla firlatmaz. */
export function parseModelTurn(raw: unknown): ParsedModelTurn {
  if (!isRecord(raw)) return { ok: false, reason: "not_object" };
  // Model hicbir alanda baglanti uretemez: butun cikti reddedilir (yedek arama calisir).
  if (URL_RE.test(JSON.stringify(raw))) return { ok: false, reason: "bad_message" };
  const message = cleanText(raw.message, CHAT_LIMITS.message);

  if (raw.action === "clarify") {
    if (message === null) return { ok: false, reason: "bad_message" };
    const question = parseClarifyQuestion(raw.question);
    if (question === null) return { ok: false, reason: "bad_question" };
    return { ok: true, turn: { action: "clarify", message, question } };
  }
  if (raw.action === "search") {
    if (message === null) return { ok: false, reason: "bad_message" };
    const intent = parseIntentPatch(raw.intent);
    if (intent === null) return { ok: false, reason: "bad_intent" };
    return { ok: true, turn: { action: "search", message, intent } };
  }
  return { ok: false, reason: "bad_action" };
}

/** Gemini `response_format.schema`. `parseModelTurn` ayni kurallari yeniden uygular. */
export function buildModelTurnSchema(): Record<string, unknown> {
  const nullableString = (maxLength: number) => ({ type: ["string", "null"], maxLength });
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "message", "question", "intent"],
    properties: {
      action: { type: "string", enum: ["clarify", "search"] },
      message: { type: "string", maxLength: CHAT_LIMITS.message },
      question: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["id", "title", "options"],
        properties: {
          id: { type: "string", maxLength: CHAT_LIMITS.questionId },
          title: { type: "string", maxLength: CHAT_LIMITS.questionTitle },
          options: {
            type: "array",
            minItems: CHAT_LIMITS.minOptions,
            maxItems: CHAT_LIMITS.maxOptions,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "description", "value"],
              properties: {
                label: { type: "string", maxLength: CHAT_LIMITS.optionLabel },
                description: nullableString(CHAT_LIMITS.optionDescription),
                value: { type: "string", maxLength: CHAT_LIMITS.optionValue },
              },
            },
          },
        },
      },
      intent: {
        type: ["object", "null"],
        additionalProperties: false,
        required: [
          "reset",
          "clear",
          "query",
          "category",
          "brand",
          "excludeBrands",
          "colors",
          "size",
          "priceMin",
          "priceMax",
          "attributes",
          "sort",
          "remove",
        ],
        properties: {
          reset: { type: "boolean" },
          clear: { type: "boolean" },
          query: nullableString(CHAT_LIMITS.queryChars),
          category: nullableString(CHAT_LIMITS.shortText),
          brand: nullableString(CHAT_LIMITS.shortText),
          excludeBrands: {
            type: "array",
            items: { type: "string" },
            maxItems: CHAT_LIMITS.maxList,
          },
          colors: { type: "array", items: { type: "string" }, maxItems: CHAT_LIMITS.maxList },
          size: nullableString(CHAT_LIMITS.shortText),
          priceMin: { type: ["integer", "null"] },
          priceMax: { type: ["integer", "null"] },
          attributes: {
            type: "array",
            maxItems: CHAT_LIMITS.maxAttributes,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["key", "value"],
              properties: {
                key: { type: "string", maxLength: CHAT_LIMITS.questionId },
                value: { type: "string", maxLength: CHAT_LIMITS.shortText },
              },
            },
          },
          sort: { type: ["string", "null"], enum: ["cheapest", "balanced", null] },
          remove: { type: "array", items: { type: "string", enum: [...REMOVABLE_FIELDS] } },
        },
      },
    },
  };
}
