/**
 * Akisli sitemap ayristirici (karar 0120). Tarayicida ve Node'da calisir; bagimlilik yoktur.
 *
 * Dosya BELLEGE TOPTAN ALINMAZ: metin parca parca beslenir, yalnizca tamamlanmis
 * `<url>...</url>` / `<sitemap>...</sitemap>` ogeleri cikarilir ve islenen kisim tampondan
 * atilir. Tampon en fazla bir ogenin boyutu kadar buyur; `MAX_ELEMENT_CHARS` asilirsa
 * ayristirma durur (bozuk ya da beklenmeyen icerik).
 *
 * Yalnizca dosyada GERCEKTEN bulunan alanlar doner. Baslik yoksa adresten uydurulmaz.
 */

/** Tek bir `<url>` / `<sitemap>` ogesinin en fazla karakter sayisi. */
export const MAX_ELEMENT_CHARS = 64 * 1024;

export class SitemapParseError extends Error {
  readonly code: "element_too_large" | "decoded_limit" | "decode_unsupported";
  constructor(code: SitemapParseError["code"], message?: string) {
    super(message ?? code);
    this.name = "SitemapParseError";
    this.code = code;
  }
}

export interface SitemapIndexEntry {
  loc: string;
  lastmod: string | null;
}

export interface SitemapUrlEntry {
  loc: string;
  /** Ilk gorselin adresi (image:loc). */
  imageLoc: string | null;
  /** Ilk gorselin basligi (image:title), yoksa aciklamasi (image:caption). */
  imageTitle: string | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** XML metin icerigi: CDATA acilir, varliklar cozulur, bosluk sadelestirilir. */
export function xmlText(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const text = cdata
    ? (cdata[1] as string)
    : raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref: string) => {
        if (ref.startsWith("#x") || ref.startsWith("#X")) {
          const code = Number.parseInt(ref.slice(2), 16);
          return Number.isFinite(code) && code > 0 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : whole;
        }
        if (ref.startsWith("#")) {
          const code = Number.parseInt(ref.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : whole;
        }
        return NAMED_ENTITIES[ref] ?? whole;
      });
  return text.replace(/\s+/g, " ").trim();
}

/** `<onek:ad>` ya da `<ad>` ogesinin ilk metin icerigi (onek serbest). */
function childText(element: string, localName: string): string | null {
  const re = new RegExp(
    `<(?:[A-Za-z][\\w.-]*:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?${localName}\\s*>`,
  );
  const m = re.exec(element);
  if (!m) return null;
  const value = xmlText(m[1] as string);
  return value ? value : null;
}

/** `<image:image>` blogunun ilki (onek serbest). */
function firstImageBlock(element: string): string | null {
  const m = /<([A-Za-z][\w.-]*:)image(?:\s[^>]*)?>([\s\S]*?)<\/\1image\s*>/.exec(element);
  return m ? (m[2] as string) : null;
}

type Kind = "url" | "sitemap";

/**
 * Artimli oge tarayicisi. `push(chunk)` tamamlanan ogeleri dondurur; `end()` tamponda
 * kapanmamis oge kaldiysa onu atar (kesilmis dosya) ve `truncated` bildirir.
 */
class ElementScanner {
  private buffer = "";
  private sawRoot = false;
  private readonly open: RegExp;
  private readonly close: RegExp;

  constructor(kind: Kind) {
    // Kok ogesi icindeki <url>/<sitemap> (onekli ad olabilir: <sm:url>).
    this.open = new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${kind}(?:\\s[^>]*)?>`, "g");
    this.close = new RegExp(`</(?:[A-Za-z][\\w.-]*:)?${kind}\\s*>`, "g");
  }

  get rootSeen(): boolean {
    return this.sawRoot;
  }

  push(chunk: string): string[] {
    this.buffer += chunk;
    if (!this.sawRoot && /<(?:[A-Za-z][\w.-]*:)?(?:urlset|sitemapindex)[\s>]/.test(this.buffer)) {
      this.sawRoot = true;
    }
    const out: string[] = [];
    let consumed = 0;
    for (;;) {
      this.open.lastIndex = consumed;
      const start = this.open.exec(this.buffer);
      if (!start) {
        // Acilis yok: yarim kalmis olabilecek son etiketi korumak icin son '<' dan itibaren tut.
        const lt = this.buffer.lastIndexOf("<");
        consumed = lt >= consumed ? lt : this.buffer.length;
        break;
      }
      this.close.lastIndex = start.index + start[0].length;
      const end = this.close.exec(this.buffer);
      if (!end) {
        consumed = start.index;
        break;
      }
      out.push(this.buffer.slice(start.index + start[0].length, end.index));
      consumed = end.index + end[0].length;
    }
    this.buffer = this.buffer.slice(consumed);
    if (this.buffer.length > MAX_ELEMENT_CHARS) {
      throw new SitemapParseError("element_too_large");
    }
    return out;
  }

  /** Kapanmamis oge kaldi mi (kesilmis dosya). */
  end(): { truncated: boolean } {
    this.open.lastIndex = 0;
    const truncated = this.open.test(this.buffer);
    this.buffer = "";
    return { truncated };
  }
}

/** Sitemap indeksi (`<sitemapindex>`) icin artimli ayristirici. */
export class SitemapIndexParser {
  private readonly scanner = new ElementScanner("sitemap");

  push(chunk: string): SitemapIndexEntry[] {
    return this.scanner.push(chunk).flatMap((el) => {
      const loc = childText(el, "loc");
      return loc ? [{ loc, lastmod: childText(el, "lastmod") }] : [];
    });
  }

  end(): { truncated: boolean; rootSeen: boolean } {
    return { ...this.scanner.end(), rootSeen: this.scanner.rootSeen };
  }
}

/** Urun sitemap'i (`<urlset>`, image uzantisi) icin artimli ayristirici. */
export class SitemapUrlsetParser {
  private readonly scanner = new ElementScanner("url");

  push(chunk: string): SitemapUrlEntry[] {
    return this.scanner.push(chunk).flatMap((el) => {
      const loc = childText(el, "loc");
      if (!loc) return [];
      // <loc> ogenin kendi adresi; gorselinki <image:image> icindedir.
      const ownLoc = childText(
        el.replace(/<([A-Za-z][\w.-]*:)image[\s\S]*?<\/\1image\s*>/g, ""),
        "loc",
      );
      const image = firstImageBlock(el);
      return [
        {
          loc: ownLoc ?? loc,
          imageLoc: image ? childText(image, "loc") : null,
          imageTitle: image ? (childText(image, "title") ?? childText(image, "caption")) : null,
        },
      ];
    });
  }

  end(): { truncated: boolean; rootSeen: boolean } {
    return { ...this.scanner.end(), rootSeen: this.scanner.rootSeen };
  }
}

/** Yanit govdesi sikistirma bicimi: HTTP katmani zaten acmissa `identity`. */
export type BodyEncoding = "identity" | "gzip" | "br";

/**
 * Dosya adresi/ilk baytlardan acilmamis sikistirma tespiti. Tarayici `Content-Encoding`
 * ile gelen govdeyi kendisi acar; burada yalnizca DOSYANIN KENDISI sikistirilmissa
 * (`.xml.gz`, `.xml.br`) ek acma gerekir. Gzip sihirli baytla (1f 8b) dogrulanir; Brotli'nin
 * sihirli bayti yoktur, yalnizca uzantiyla taninir.
 */
export function detectEncoding(url: string, firstBytes: Uint8Array): BodyEncoding {
  if (firstBytes[0] === 0x1f && firstBytes[1] === 0x8b) return "gzip";
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* goreli yol */
  }
  if (/\.br$/i.test(path)) return "br";
  return "identity";
}

export type DecompressorFactory = (
  format: "gzip" | "brotli",
) => TransformStream<Uint8Array, Uint8Array>;

/** Platformun DecompressionStream'i; desteklenmeyen bicimde `decode_unsupported`. */
export const platformDecompressor: DecompressorFactory = (format) => {
  try {
    return new DecompressionStream(
      format as ConstructorParameters<typeof DecompressionStream>[0],
    ) as unknown as TransformStream<Uint8Array, Uint8Array>;
  } catch {
    throw new SitemapParseError("decode_unsupported", `${format} acilamiyor`);
  }
};

export interface TextStreamResult {
  /** Acilmis govdenin bayt sayisi (butce muhasebesi). */
  decodedBytes: () => number;
  stream: ReadableStream<string>;
}

/**
 * Ham govdeyi (gerekirse acarak) metin akisina cevirir. Bayt sayaci acilmis veriyi sayar.
 * `maxDecodedBytes` asilirsa akis hata verir (sikistirma bombasi / butce korumasi).
 */
export async function bodyToTextStream(
  body: ReadableStream<Uint8Array>,
  url: string,
  options: { maxDecodedBytes: number; decompressor?: DecompressorFactory },
): Promise<TextStreamResult> {
  const reader = body.getReader();
  const first = await reader.read();
  const head = first.value ?? new Uint8Array();
  const encoding = detectEncoding(url, head);
  // Okunan ilk parca geri konur.
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength > 0) controller.enqueue(head);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const factory = options.decompressor ?? platformDecompressor;
  const decoded =
    encoding === "identity"
      ? replay
      : replay.pipeThrough(factory(encoding === "gzip" ? "gzip" : "brotli"));
  let count = 0;
  const counted = decoded.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        count += chunk.byteLength;
        if (count > options.maxDecodedBytes) {
          controller.error(new SitemapParseError("decoded_limit"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return {
    decodedBytes: () => count,
    stream: counted.pipeThrough(utf8Decoder()),
  };
}

/** UTF-8 akis cozucu (parca sinirinda bolunen cok baytli karakterler korunur). */
function utf8Decoder(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder("utf-8");
  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      if (text) controller.enqueue(text);
    },
    flush(controller) {
      const text = decoder.decode();
      if (text) controller.enqueue(text);
    },
  });
}

/**
 * Basit bir HTML/dogrulama sayfasi tespiti: sitemap yerine HTML geldiyse (engel ya da
 * yonlendirme sayfasi) icerik ayristirilmaz, engel olarak raporlanir.
 */
export function looksLikeHtml(firstText: string): boolean {
  const head = firstText.slice(0, 2048).toLowerCase();
  return (
    /<!doctype html|<html[\s>]/.test(head) ||
    head.includes("captcha") ||
    head.includes("cf-challenge") ||
    head.includes("access denied")
  );
}
