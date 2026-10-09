import { CHAT_COPY } from "../../sohbet/chat-copy.ts";

/** Neden kodu → yönetici etiketi. `none`: neden seçilmeden gönderilen olumsuz oy. */
export function reasonLabel(code: string): string {
  if (code === "none") return "Neden seçilmedi";
  return (CHAT_COPY.feedbackReasons as Record<string, string>)[code] ?? code;
}

/** `payload.source` değerleri (karar 0074): modelden mi, deterministik yedekten mi. */
export function searchSourceLabel(source: string | null): string {
  if (source === "model") return "Model yorumladı";
  if (source === "fallback") return "Yedek (deterministik) arama";
  return "—";
}

export function percent(value: number | null): string {
  return value === null
    ? "—"
    : `%${(value * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`;
}
