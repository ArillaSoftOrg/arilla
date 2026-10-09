/**
 * Sohbette ürün linki: saf parçalar (karar 0090). Veritabanı, ağ ve model yok.
 *
 * - `extractChatLink`: mesajın herhangi bir yerinden ilk geçerli bağlantıyı çıkarır.
 * - `ChatLinkPayload` / `parseChatLinkPayload`: asistan `notice` mesajının
 *   `payload.link` alanı (yeni mesaj türü ya da migration yok).
 * - `resolveChatReference`: takip mesajının neye bağlandığı (link ya da görsel).
 * - `chatLinkFailureCopy`: kararlı hata kodu -> kısa Türkçe metin + sonraki adım.
 */
import { checkLinkSearchUrl, type LinkPreferences } from "../discovery/index.ts";

// ---------------------------------------------------------------------------
// Bağlantı çıkarımı
// ---------------------------------------------------------------------------

export type ChatLinkInvalidReason = "invalid" | "blocked";

export type ChatLinkExtraction =
  | { found: false }
  | {
      found: true;
      ok: true;
      /** Kullanıcının yazdığı (www. ise https:// eklenmiş) adres. */
      url: string;
      normalizedUrl: string;
      /** İlk geçerli link dışındaki bağlantı sayısı (geçerli ya da değil). */
      extraLinks: number;
      /** Bağlantılar çıkarılmış, boşlukları toparlanmış metin. */
      remainder: string;
    }
  | {
      found: true;
      ok: false;
      reason: ChatLinkInvalidReason;
      extraLinks: number;
      remainder: string;
    };

const CANDIDATE_RE = /(?:https?:\/\/|(?<![\p{L}\p{N}./@-])www\.)[^\s<>"'`]+/giu;
const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?", "…", "”", "’", "»"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Sondaki noktalama ve eşleşmeyen kapanış parantezleri bağlantıya ait değildir. */
function trimCandidate(raw: string): string {
  let text = raw;
  for (;;) {
    const last = text.at(-1);
    if (last === undefined) return text;
    if (TRAILING_PUNCT.has(last)) {
      text = text.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener !== undefined) {
      const opens = text.split(opener).length - 1;
      const closes = text.split(last).length - 1;
      if (closes > opens) {
        text = text.slice(0, -1);
        continue;
      }
    }
    return text;
  }
}

function tidyRemainder(text: string): string {
  const tokens = text
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, " ")
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
  return tokens.join(" ").trim();
}

/**
 * Metindeki `https?://` ve `www.` bağlantılarını bulur; ilk GEÇERLİ olanı seçer
 * (`checkLinkSearchUrl`: iç ağ, IP, kimlik bilgisi, izinsiz port reddedilir).
 * Geçerli bağlantı yoksa ilk adayın nedeni döner.
 */
export function extractChatLink(text: string): ChatLinkExtraction {
  const spans: { start: number; end: number; url: string }[] = [];
  for (const match of text.matchAll(CANDIDATE_RE)) {
    const trimmed = trimCandidate(match[0]);
    if (trimmed.length === 0) continue;
    const start = match.index ?? 0;
    const url = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
    spans.push({ start, end: start + trimmed.length, url });
  }
  if (spans.length === 0) return { found: false };

  let remainder = "";
  let cursor = 0;
  for (const span of spans) {
    remainder += `${text.slice(cursor, span.start)} `;
    cursor = span.end;
  }
  remainder = tidyRemainder(remainder + text.slice(cursor));

  let firstReason: ChatLinkInvalidReason | null = null;
  for (const span of spans) {
    const checked = checkLinkSearchUrl(span.url);
    if (checked.ok) {
      return {
        found: true,
        ok: true,
        url: span.url,
        normalizedUrl: checked.normalized.url,
        extraLinks: spans.length - 1,
        remainder,
      };
    }
    firstReason ??= checked.reason;
  }
  return {
    found: true,
    ok: false,
    reason: firstReason ?? "invalid",
    extraLinks: spans.length - 1,
    remainder,
  };
}

// ---------------------------------------------------------------------------
// Mesaj yükü (payload.link)
// ---------------------------------------------------------------------------

/** Tercih metni anlaşılamadıysa kullanıcıya söylenen not (karar 0090). */
export type ChatLinkNote = "preference_not_understood";

export interface ChatLinkPayload {
  version: 1;
  /** `link_resolution_request.id`; sorgu açılamadıysa (hata) `null`. */
  requestId: string | null;
  normalizedUrl: string | null;
  /** Bağlantısız kullanıcı metni (yalnızca sahibinin sohbetinde saklanır). */
  remainderText: string;
  preferences: LinkPreferences;
  extraLinks: number;
  /** Sorgu açılmadan bitenlerde kararlı hata kodu; aksi halde `null`. */
  errorCode: string | null;
  note: ChatLinkNote | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PRICE_KURUS = 10_000_000 * 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanKurus(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_PRICE_KURUS
    ? value
    : null;
}

function cleanLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, 60);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= 5) break;
  }
  return out;
}

/** Saklanan ya da modelden/ayrıştırıcıdan gelen tercihi katı biçime indirir. */
export function sanitizeLinkPreferences(raw: unknown): LinkPreferences {
  if (!isRecord(raw)) return {};
  const out: LinkPreferences = {};
  const min = cleanKurus(raw.priceMinKurus);
  const max = cleanKurus(raw.priceMaxKurus);
  if (min !== null) out.priceMinKurus = min;
  if (max !== null) out.priceMaxKurus = max;
  const colors = cleanLabels(raw.colors);
  if (colors.length > 0) out.colors = colors;
  const styles = cleanLabels(raw.styles);
  if (styles.length > 0) out.styles = styles;
  if (raw.sort === "cheapest") out.sort = "cheapest";
  return out;
}

/** Kararlı kod biçimi; serbest metin payload'a girmez. */
const ERROR_CODE_RE = /^[a-z][a-z_]{0,39}$/;

/** `payload.link`i doğrular; bozuksa `null`. Asla fırlatmaz. */
export function parseChatLinkPayload(raw: unknown): ChatLinkPayload | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  const requestId =
    typeof raw.requestId === "string" && UUID_RE.test(raw.requestId) ? raw.requestId : null;
  const errorCode =
    typeof raw.errorCode === "string" && ERROR_CODE_RE.test(raw.errorCode) ? raw.errorCode : null;
  // Ne bir sorgu ne de bir hata kodu: anlamsız kayıt.
  if (requestId === null && errorCode === null) return null;
  const normalizedUrl =
    typeof raw.normalizedUrl === "string" && raw.normalizedUrl.length <= 2048
      ? raw.normalizedUrl
      : null;
  const extra =
    typeof raw.extraLinks === "number" && Number.isInteger(raw.extraLinks) && raw.extraLinks >= 0
      ? Math.min(raw.extraLinks, 20)
      : 0;
  return {
    version: 1,
    requestId,
    normalizedUrl,
    remainderText: typeof raw.remainderText === "string" ? raw.remainderText.slice(0, 500) : "",
    preferences: sanitizeLinkPreferences(raw.preferences),
    extraLinks: extra,
    errorCode,
    note: raw.note === "preference_not_understood" ? "preference_not_understood" : null,
  };
}

// ---------------------------------------------------------------------------
// Referans: takip mesajı neye bağlanır?
// ---------------------------------------------------------------------------

/** `ChatMessageView`in yapısal alt kümesi (service.ts ile döngü kurmamak için). */
export interface ChatReferenceMessage {
  role: "user" | "assistant";
  kind: string;
  link?: ChatLinkPayload | null;
  attachmentId?: string | null;
}

export type ChatReference =
  | { type: "link"; link: ChatLinkPayload; index: number }
  | { type: "image"; index: number };

/**
 * Konuşmadaki en yeni referans: sorgusu açılmış bir link mesajı (asistan
 * `notice` + `payload.link`) ya da görsel ekli kullanıcı mesajı. Daha yeni olan
 * kazanır. Referanstan SONRA sıradan bir asistan cevabı (`search`/`clarify`)
 * geldiyse konu değişmiştir: referans düşer. Hata ile biten (sorgusuz) link
 * mesajı referans olamaz.
 */
export function resolveChatReference(
  messages: readonly ChatReferenceMessage[],
): ChatReference | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant") {
      if (message.kind === "notice" && message.link) {
        return message.link.requestId !== null
          ? { type: "link", link: message.link, index: i }
          : null;
      }
      if (message.kind === "search" || message.kind === "clarify") return null;
      continue;
    }
    if (message.attachmentId) return { type: "image", index: i };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hata ve durum metinleri
// ---------------------------------------------------------------------------

export interface ChatLinkCopy {
  title: string;
  description: string;
}

/**
 * Kullanıcıya gösterilecek metin. Ton `apps/web/app/ara/link/link-search-copy.ts`
 * ile aynıdır; sohbette ek olarak sonraki adım (fotoğraf ya da kısa tarif) önerilir.
 * Bilinmeyen kod genel metne düşer.
 */
export function chatLinkFailureCopy(
  code: string,
  options: { imageEnabled?: boolean } = {},
): ChatLinkCopy {
  const next = options.imageEnabled
    ? "Ürünün fotoğrafını yükleyebilir ya da kısaca tarif edebilirsin."
    : "Ürünü kısaca tarif edebilirsin.";
  const unavailable: ChatLinkCopy = {
    title: "Site şu an yanıt vermiyor.",
    description: `Biraz sonra tekrar deneyebilirsin. ${next}`,
  };
  switch (code) {
    case "robots_disallowed":
      return {
        title: "Bu site ürün sayfasının okunmasına izin vermiyor.",
        description: next,
      };
    case "access_denied":
      return {
        title: "Bu sayfaya erişemedik.",
        description: `Sayfa giriş istiyor ya da ziyaretçileri engelliyor olabilir. ${next}`,
      };
    case "not_found":
      return {
        title: "Bu bağlantıda bir ürün sayfası bulamadık.",
        description: `Ürün kaldırılmış ya da adres değişmiş olabilir. ${next}`,
      };
    case "no_product":
      return {
        title: "Bu sayfada ürün bilgisi bulamadık.",
        description: `Bağlantının bir ürün sayfasına gittiğinden emin ol. ${next}`,
      };
    case "unsupported_content":
      return {
        title: "Bu bağlantı bir ürün sayfasına gitmiyor.",
        description: `Ürün sayfasının bağlantısını göndermeyi dene. ${next}`,
      };
    case "too_large":
      return {
        title: "Bu sayfayı inceleyemedik.",
        description: `Sayfa beklenenden çok büyük. ${next}`,
      };
    case "blocked_destination":
      return {
        title: "Bu bağlantıyı açamıyoruz.",
        description: `Yalnızca herkese açık mağaza sayfalarını inceleyebiliyoruz. ${next}`,
      };
    case "invalid_url":
      return {
        title: "Bu bir ürün bağlantısına benzemiyor.",
        description: `Bağlantı https:// ile başlamalı ve bir mağazanın ürün sayfasını göstermeli. ${next}`,
      };
    case "too_many_redirects":
      return {
        title: "Bu bağlantı bizi çok fazla yönlendirdi.",
        description: `Ürün sayfasının doğrudan bağlantısını göndermeyi dene. ${next}`,
      };
    case "no_rights":
      return {
        title: "Bugünkü arama hakların bitti.",
        description: `Günlük hakların gece 00:00'da yenilenir. Bu arada yazarak aramaya devam edebilirsin. ${next}`,
      };
    case "search_rate_limited":
      return {
        title: "Biraz hızlı gittin.",
        description:
          "Bir dakika sonra bağlantıyı tekrar gönderir misin? Yazarak aramaya devam edebilirsin.",
      };
    case "busy":
      return {
        title: "Önceki bağlantı aramanın hâlâ sürüyor.",
        description: "Bitince bu bağlantıyı yeniden gönderebilirsin.",
      };
    case "retry":
      return {
        title: "Bu bağlantıyı şu an inceleyemedik.",
        description: "Bağlantıyı tekrar gönderir misin? Hakkın geri verildi.",
      };
    case "queue_unavailable":
      return {
        title: "Şu an bağlantıları inceleyemiyoruz.",
        description: `Biraz sonra tekrar dene. ${next}`,
      };
    case "stale":
      return {
        title: "İnceleme beklenenden uzun sürdü.",
        description: `Bağlantıyı biraz sonra tekrar gönderebilirsin. ${next}`,
      };
    case "text_only":
      return {
        title: "Ürün görseli okunamadı.",
        description: "Sonuçlar ürün adına ve markasına göre sıralandı.",
      };
    case "empty":
      return {
        title: "Bu ürüne benzeyen bir şey bulamadık.",
        description: next,
      };
    case "preference_not_understood":
      return {
        title: "Tercihini tam anlayamadım.",
        description:
          "Renk, fiyat aralığı ya da daha uygun fiyattan başlayan sıralama gibi şeyleri yazabilirsin.",
      };
    case "rate_limited":
    case "upstream_error":
    case "timeout":
    case "fetch_failed":
    case "http_error":
      return unavailable;
    default:
      return {
        title: "Bu bağlantıyı şu an inceleyemedik.",
        description: `Biraz sonra tekrar deneyebilirsin. ${next}`,
      };
  }
}
