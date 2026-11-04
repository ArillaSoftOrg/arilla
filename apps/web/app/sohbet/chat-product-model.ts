import type { SearchIntent } from "@arilla/core";

export interface ChatToolProduct {
  productId: number;
  slug: string;
  title: string;
  imageUrl: string | null;
  brand: string | null;
  displayPrice: string;
  sourceLabel?: string;
  meta: string;
}

export interface ChatToolDetail extends ChatToolProduct {
  color: string | null;
  stock: string;
  variants: string[];
  priceKurus: number | null;
  priceAlarmAvailable: boolean;
}

export interface ChatPriceAlarm {
  productId: number;
  alertId: number;
  targetPrice: number;
}

export interface ChatToolAccount {
  savedProductIds: number[];
  alarms: ChatPriceAlarm[];
}

export type ChatToolFailure =
  | "session_expired"
  | "not_found"
  | "invalid"
  | "unsupported"
  | "unavailable";
export type ChatToolResult<T> = ({ status: "ok" } & T) | { status: ChatToolFailure };

export interface ChatToolBackend {
  account: () => Promise<ChatToolResult<{ account: ChatToolAccount }>>;
  save: (slug: string, saved: boolean) => Promise<ChatToolResult<{ saved: boolean }>>;
  alarm: (
    slug: string,
    targetPrice: number | null,
  ) => Promise<ChatToolResult<{ alarm: ChatPriceAlarm | null }>>;
  details: (slugs: string[]) => Promise<ChatToolResult<{ products: ChatToolDetail[] }>>;
  similar: (slug: string) => Promise<ChatToolResult<{ products: ChatToolProduct[] }>>;
}

export const CHAT_TOOL_ERRORS: Record<ChatToolFailure, string> = {
  session_expired: "Oturumun sona ermiş olabilir. Giriş yapıp tekrar deneyebilirsin.",
  not_found: "Bu sohbet veya ürün artık görüntülenemiyor.",
  invalid: "Bilgileri kontrol edip tekrar dener misin?",
  unsupported: "Bu ürün için şu an TL fiyat alarmı kurulamıyor.",
  unavailable: "İşlem tamamlanamadı. Biraz sonra tekrar deneyebilirsin.",
};

/** Kullanıcının yazdığı TL tutarını yuvarlamadan tam sayı kuruşa çevirir. */
export function parseChatPrice(raw: string): number | null {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export interface ChatFilterDraft {
  brand: string;
  colors: string;
  size: string;
  priceMin: string;
  priceMax: string;
}

export function chatFilterDraft(intent: SearchIntent): ChatFilterDraft {
  return {
    brand: intent.brand ?? "",
    colors: intent.colors.join(", "),
    size: intent.size ?? "",
    priceMin: intent.priceMin === null ? "" : String(intent.priceMin),
    priceMax: intent.priceMax === null ? "" : String(intent.priceMax),
  };
}

/** Yalnızca değişen tercihleri mevcut sohbetin normal mesaj yoluna hazırlar. */
export function chatFilterMessage(intent: SearchIntent, draft: ChatFilterDraft): string | null {
  const before = chatFilterDraft(intent);
  const lines: string[] = [];
  const fields = [
    ["brand", "Marka tercihim", "Marka kısıtını kaldır"],
    ["colors", "Renk tercihim", "Renk kısıtını kaldır"],
    ["size", "Beden tercihim", "Beden kısıtını kaldır"],
  ] as const;
  for (const [key, label, remove] of fields) {
    const value = draft[key].replace(/\s+/g, " ").trim();
    if (value.length > 60 || /https?:\/\//i.test(value)) return null;
    if (value !== before[key]) lines.push(value ? `${label}: ${value}.` : `${remove}.`);
  }
  const prices: Record<"priceMin" | "priceMax", number | null> = { priceMin: null, priceMax: null };
  for (const key of ["priceMin", "priceMax"] as const) {
    const value = draft[key].trim();
    if (value !== "" && (!/^\d+$/.test(value) || Number(value) > 10_000_000)) return null;
    prices[key] = value === "" ? null : Number(value);
    if (value !== before[key]) {
      lines.push(
        value
          ? `Bütçem ${key === "priceMin" ? "en az" : "en fazla"} ${value} TL olsun.`
          : `Bütçenin ${key === "priceMin" ? "alt" : "üst"} sınırını kaldır.`,
      );
    }
  }
  if (prices.priceMin !== null && prices.priceMax !== null && prices.priceMin > prices.priceMax)
    return null;
  const text = lines.join(" ");
  return text.length <= 400 ? text : null;
}
