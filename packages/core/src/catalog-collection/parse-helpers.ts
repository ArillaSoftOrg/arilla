/** Arama sayfasi HTML'ini okumak icin kucuk, bagimsiz yardimcilar. */

/** Next.js App Router akisi: tum `self.__next_f.push([1,"..."])` parcalarini birlestirir. */
export function flattenNextFlight(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      parts.push(JSON.parse(m[1] ?? '""') as string);
    } catch {
      /* bozuk parca: atla */
    }
  }
  return parts.join("");
}

/**
 * `text` icinde `key`den hemen sonra baslayan JSON dizisini/nesnesini dengeli
 * parantezle bulup ayristirir. `key` acilis karakteriyle bitmelidir (ornegin `"products":[`).
 */
export function jsonValueAfter(text: string, key: string): unknown {
  const k = text.indexOf(key);
  if (k < 0) return null;
  const start = k + key.length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** id'si verilen <script> etiketinin metni. */
export function scriptTextById(html: string, id: string): string | null {
  const re = new RegExp(`<script[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, "i");
  return re.exec(html)?.[1] ?? null;
}

/**
 * "1299.90" | 1299.9 | 289 -> kuruş (tam sayı). Ondalık metinle işlenir (float çarpımı
 * yok); 2'den fazla ondalık, bilimsel gösterim, virgül ya da <= 0 ise null:
 * yuvarlanmış yanlış fiyat göstermektense kaydı eler.
 */
export function decimalToKurus(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const kurus = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(kurus) && kurus > 0 ? kurus : null;
}

export function httpsUrlOn(raw: unknown, base: string, hostSuffix: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (u.hostname !== hostSuffix && !u.hostname.endsWith(`.${hostSuffix}`)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
