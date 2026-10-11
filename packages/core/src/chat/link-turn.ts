/**
 * Sohbette link turu (karar 0090). `service.ts`ın `runPendingTurn`ü, bayrak
 * açıkken modelden ÖNCE buraya sorar; `null` = bu mesaj bir link turu değil,
 * normal akış sürer.
 *
 * - Link içeren mesaj: model ÇAĞRILMAZ. Hak/kuyruk/önbellek/iade tümüyle
 *   mevcut `runChargedLinkSearch`te (burada yeniden uygulanmaz).
 * - Link referansı varken gelen "daha ucuz", "siyah olsun" gibi takip: yeni
 *   getirme/hak YOK, aynı `requestId`, birleşik tercih.
 * - Yalnızca `CHAT_LINK_INTERPRET_ENABLED` açıkken ve deterministik ayrıştırma
 *   bir kalıntı (`leftover`) bıraktığında tek model çağrısı (Faz 5).
 *
 * Dönen plan henüz yazılmamıştır: kalıcılık (tek işlem, `api_usage`) service.ts'tedir.
 */
import type { Database } from "@arilla/db";
import { hasLinkPreferences, InvalidUrlError, type LinkPreferences } from "../discovery/index.ts";
import {
  type ChargedLinkSearchResult,
  runChargedLinkSearch,
} from "../entitlement/charged-search.ts";
import type { LlmCall } from "../llm/client.ts";
import { isRedisUnavailableError } from "../redis/client.ts";
import type { LexiconEntry } from "../search/lexicon.ts";
import { loadLexiconCached } from "../search/lexicon-cache.ts";
import { isChatImageEnabled, isChatLinkInterpretEnabled } from "./config.ts";
import { emptyIntent } from "./intent.ts";
import {
  type ChatInterpreter,
  interpretTurn,
  MAX_CONSECUTIVE_CLARIFICATIONS,
  type TranscriptMessage,
} from "./interpreter.ts";
import {
  type ChatLinkNote,
  type ChatLinkPayload,
  type ChatReferenceMessage,
  chatLinkFailureCopy,
  extractChatLink,
  resolveChatReference,
} from "./link.ts";
import {
  describeLinkPreferences,
  linkPreferencesFromPatch,
  mergeLinkPreferences,
  type ParsedLinkPreferences,
  parseLinkPreferences,
} from "./link-preference-text.ts";

export interface LinkTurnMessage extends ChatReferenceMessage {
  content: string;
}

export interface LinkTurnPlan {
  /** Asistan `notice` mesajının metni. */
  content: string;
  link: ChatLinkPayload;
  /** `api_usage`a yazılacak model denemeleri (çoğunlukla boş). */
  calls: LlmCall[];
  /** Bu turun yazacağı (ya da yeniden kullanacağı) hak kaydı yok: hak `runChargedLinkSearch`te. */
  kind: "new_link" | "refinement" | "failure";
}

export interface LinkTurnInput {
  userId: number;
  conversationId: string;
  messages: readonly LinkTurnMessage[];
  /** Son (cevapsız) kullanıcı mesajının sırası: deterministik istek anahtarı. */
  lastSeq: number;
  /** Sağlayıcı bütçesi model çağrısına izin veriyor mu (`chatProviderBudget`). */
  modelAllowed: boolean;
  interpreter: ChatInterpreter;
}

/** Aynı kullanıcı mesajı yeniden işlenirse AYNI anahtar: hak/kayıt ikilenmez. */
export function chatLinkRequestKey(conversationId: string, seq: number): string {
  return `chatlink-${conversationId}-${seq}`;
}

/** Hak harcamayan redler -> kararlı hata kodu. */
function blockedCode(result: Exclude<ChargedLinkSearchResult, { status: "queued" }>): string {
  return result.status === "rate_limited" ? "search_rate_limited" : result.status;
}

function failurePlan(
  code: string,
  base: { remainder: string; normalizedUrl: string | null; extraLinks: number },
): LinkTurnPlan {
  const copy = chatLinkFailureCopy(code, { imageEnabled: isChatImageEnabled() });
  return {
    kind: "failure",
    content: `${copy.title} ${copy.description}`,
    calls: [],
    link: {
      version: 1,
      requestId: null,
      normalizedUrl: base.normalizedUrl,
      remainderText: base.remainder,
      preferences: {},
      extraLinks: base.extraLinks,
      errorCode: code,
      note: null,
    },
  };
}

interface PreferenceResolution {
  preferences: LinkPreferences;
  note: ChatLinkNote | null;
  calls: LlmCall[];
}

/** Kısa, tek konulu bir takip mı (Faz 5'te modele gitmeye değer mi)? */
function looksLikeRefinement(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= 80 && trimmed.split(/\s+/).length <= 8;
}

/**
 * Deterministik ayrıştırma + (yalnızca bayrak açık ve kalıntı varken) tek model
 * çağrısı. Model hatası/zaman aşımı/tavan -> deterministik yedek; çağrı
 * kayıtları her durumda döner (`api_usage`).
 */
async function resolvePreferences(
  input: LinkTurnInput,
  context: {
    base: LinkPreferences;
    parsed: ParsedLinkPreferences;
    text: string;
    lexicon: readonly LexiconEntry[];
  },
): Promise<PreferenceResolution> {
  const { base, parsed, text, lexicon } = context;
  const merged = mergeLinkPreferences(base, parsed);
  if (parsed.leftover.length === 0) return { preferences: merged, note: null, calls: [] };
  if (!isChatLinkInterpretEnabled()) {
    return { preferences: merged, note: "preference_not_understood", calls: [] };
  }

  // Modele YALNIZCA URL'siz kullanıcı metinleri gider: asistan mesajı, link
  // mesajı, sayfa başlığı/metni/görseli gitmez.
  const earlier: TranscriptMessage[] = [];
  for (const message of input.messages.slice(0, -1)) {
    if (message.role !== "user" || message.kind !== "text" || message.attachmentId) continue;
    if (extractChatLink(message.content).found) continue;
    earlier.push({ role: "user", kind: "text", text: message.content });
  }
  const outcome = await interpretTurn(
    input.interpreter,
    {
      messages: [...earlier.slice(-3), { role: "user", kind: "text", text }],
      // `mergeSearchIntent` ilk aramada bir `query` ister; yama yalnız tercih taşır.
      currentIntent: emptyIntent("ürün"),
      pendingQuestion: null,
      clarifyCount: MAX_CONSECUTIVE_CLARIFICATIONS,
      input: { kind: "text", text },
      purpose: "link_preference",
    },
    { modelAllowed: input.modelAllowed },
  );

  if (outcome.kind === "turn" && outcome.source === "model" && outcome.turn.action === "search") {
    const fromModel = linkPreferencesFromPatch(outcome.turn.intent, lexicon);
    // Açıkça yazılanı deterministik ayrıştırma belirler; model yalnız boşluğu doldurur.
    const extra: LinkPreferences = {};
    const known = parsed.preferences;
    if (!known.colors?.length && fromModel.colors) extra.colors = fromModel.colors;
    if (!known.styles?.length && fromModel.styles) extra.styles = fromModel.styles;
    if (known.priceMinKurus == null && known.priceMaxKurus == null) {
      if (fromModel.priceMinKurus != null) extra.priceMinKurus = fromModel.priceMinKurus;
      if (fromModel.priceMaxKurus != null) extra.priceMaxKurus = fromModel.priceMaxKurus;
    }
    if (!known.sort && fromModel.sort) extra.sort = fromModel.sort;
    const gained = hasLinkPreferences(extra);
    return {
      preferences: gained
        ? mergeLinkPreferences(merged, { preferences: extra, clearPrice: false })
        : merged,
      note: gained ? null : "preference_not_understood",
      calls: outcome.calls,
    };
  }
  // provider_error, tavan, süzgeç ya da bozuk çıktı: tanınanlar uygulanır.
  return { preferences: merged, note: "preference_not_understood", calls: outcome.calls };
}

function summaryText(preferences: LinkPreferences, note: ChatLinkNote | null): string {
  const parts = describeLinkPreferences(preferences);
  const lead = parts.length > 0 ? ` Tercihlerin: ${parts.join("; ")}.` : "";
  const warn = note
    ? ` ${chatLinkFailureCopy("preference_not_understood").title} Anlayabildiklerimi uyguladım.`
    : "";
  return `${lead}${warn}`;
}

async function loadLexiconSafely(db: Database): Promise<LexiconEntry[]> {
  try {
    return await loadLexiconCached(db);
  } catch {
    // Sözlük okunamadı: renk/stil tanınmaz, sohbet kesilmez.
    return [];
  }
}

/**
 * Bu kullanıcı mesajı bir link turu mu? Evetse planı döner (henüz yazılmadı).
 * Bekleyen mesaj yoksa, metin değilse ya da görsel ekliyse (karar 0078 davranışı
 * değişmez) `null`.
 */
export async function planLinkTurn(
  db: Database,
  input: LinkTurnInput,
): Promise<LinkTurnPlan | null> {
  const last = input.messages.at(-1);
  if (last?.role !== "user" || last.kind !== "text" || last.attachmentId) return null;

  const extraction = extractChatLink(last.content);
  const lexicon = await loadLexiconSafely(db);

  if (extraction.found) {
    const base = {
      remainder: extraction.remainder,
      normalizedUrl: extraction.ok ? extraction.normalizedUrl : null,
      extraLinks: extraction.extraLinks,
    };
    if (!extraction.ok) {
      return failurePlan(
        extraction.reason === "blocked" ? "blocked_destination" : "invalid_url",
        base,
      );
    }

    let result: ChargedLinkSearchResult;
    try {
      result = await runChargedLinkSearch(db, {
        userId: input.userId,
        sessionId: `chat:${input.conversationId}`,
        requestKey: chatLinkRequestKey(input.conversationId, input.lastSeq),
        urlRaw: extraction.url,
      });
    } catch (error) {
      if (error instanceof InvalidUrlError) return failurePlan("invalid_url", base);
      if (isRedisUnavailableError(error)) return failurePlan("queue_unavailable", base);
      throw error;
    }
    if (result.status !== "queued") return failurePlan(blockedCode(result), base);

    const parsed = parseLinkPreferences(extraction.remainder, lexicon);
    const resolution = await resolvePreferences(input, {
      base: {},
      parsed,
      text: extraction.remainder,
      lexicon,
    });
    const extra =
      extraction.extraLinks > 0 ? " Birden fazla bağlantı gönderdin; ilkini inceledim." : "";
    return {
      kind: "new_link",
      content: `Bağlantıdaki ürünü inceliyorum; benzerlerini aşağıda göstereceğim.${summaryText(resolution.preferences, resolution.note)}${extra}`,
      calls: resolution.calls,
      link: {
        version: 1,
        requestId: result.requestId,
        normalizedUrl: extraction.normalizedUrl,
        remainderText: extraction.remainder,
        preferences: resolution.preferences,
        extraLinks: extraction.extraLinks,
        errorCode: null,
        note: resolution.note,
      },
    };
  }

  // Bağlantısız mesaj: bir link referansının iyileştirmesi mi?
  const reference = resolveChatReference(input.messages);
  if (reference?.type !== "link") return null;
  const parsed = parseLinkPreferences(last.content, lexicon);
  const worthModel =
    isChatLinkInterpretEnabled() &&
    parsed.leftover.length > 0 &&
    parsed.topicWords.length === 0 &&
    looksLikeRefinement(last.content);
  if (!parsed.recognized && !worthModel) return null;

  const resolution = await resolvePreferences(input, {
    base: reference.link.preferences,
    parsed,
    text: last.content,
    lexicon,
  });
  const changed =
    JSON.stringify(resolution.preferences) !== JSON.stringify(reference.link.preferences);
  const lead = changed
    ? "Tercihlerini güncelledim, sonuçları aşağıda yeniledim."
    : "Sonuçlar aynı kaldı.";
  return {
    kind: "refinement",
    content: `${lead}${summaryText(resolution.preferences, resolution.note)}`,
    calls: resolution.calls,
    link: {
      ...reference.link,
      preferences: resolution.preferences,
      extraLinks: 0,
      remainderText: last.content.slice(0, 500),
      note: resolution.note,
    },
  };
}
