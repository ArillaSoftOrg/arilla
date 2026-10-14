/**
 * Ayristiricilarin tek girdisi: sayfada ZATEN bulunan metinler. Ag istegi yok.
 *
 * Eklentinin icerik betigi (izole dunya) `collectPageInputs(document, location.href)`
 * cagirir; `<script>` etiketlerinin metni izole dunyadan da okunabilir, sayfanin
 * JavaScript degiskenlerine (window[...]) erisim gerekmez. Testler ve kuru calisma
 * ayni girdiyi kayitli HTML'den (`pageInputsFromHtml`) uretir.
 */

export interface PageInputs {
  url: string;
  observedAt: string;
  /** Turu belirtilmemis ya da text/javascript olan satir ici betiklerin metni. */
  scriptTexts: string[];
  /** `application/ld+json` betiklerinin metni. */
  jsonLdTexts: string[];
  /** Hepsiburada: `<script id="reduxStore">` metni (varsa). */
  reduxStoreText?: string | null;
}

interface ScriptLike {
  readonly type: string;
  readonly id?: string;
  readonly textContent: string | null;
}

interface DocumentLike {
  querySelectorAll(selector: "script"): ArrayLike<ScriptLike>;
}

export function collectPageInputs(
  doc: DocumentLike,
  url: string,
  observedAt = new Date().toISOString(),
): PageInputs {
  const scripts = Array.from(doc.querySelectorAll("script"));
  return {
    url,
    observedAt,
    scriptTexts: scripts
      .filter((s) => !s.type || s.type === "text/javascript")
      .map((s) => s.textContent ?? ""),
    jsonLdTexts: scripts
      .filter((s) => s.type === "application/ld+json")
      .map((s) => s.textContent ?? ""),
    reduxStoreText: scripts.find((s) => s.id === "reduxStore")?.textContent ?? null,
  };
}

/** Kayitli HTML'den ayni girdi (yalnizca kuru calisma ve testler icin; DOM gerekmez). */
export function pageInputsFromHtml(html: string, url: string, observedAt: string): PageInputs {
  const scriptTexts: string[] = [];
  const jsonLdTexts: string[] = [];
  let reduxStoreText: string | null = null;
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const type = /\btype\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (type === "application/ld+json") jsonLdTexts.push(body);
    else if (!type || type === "text/javascript") scriptTexts.push(body);
    if (/\bid\s*=\s*"reduxStore"/.test(attrs)) reduxStoreText = body;
  }
  return { url, observedAt, scriptTexts, jsonLdTexts, reduxStoreText };
}

/** `window["<anahtar>"]=<json>` bicimindeki gomulu nesneyi bulur; yoksa ya da bozuksa null. */
export function findWindowJson(scriptTexts: readonly string[], key: string): unknown {
  const marker = `window["${key}"]=`;
  for (const text of scriptTexts) {
    const i = text.indexOf(marker);
    if (i < 0) continue;
    const body = text
      .slice(i + marker.length)
      .trim()
      .replace(/;\s*$/, "");
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

export function parseJsonLd(jsonLdTexts: readonly string[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const text of jsonLdTexts) {
    try {
      const parsed: unknown = JSON.parse(text);
      for (const n of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!n || typeof n !== "object") continue;
        const graph = (n as Record<string, unknown>)["@graph"];
        if (Array.isArray(graph)) nodes.push(...(graph as Record<string, unknown>[]));
        else nodes.push(n as Record<string, unknown>);
      }
    } catch {}
  }
  return nodes;
}
