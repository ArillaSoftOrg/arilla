/**
 * Konusmali kesif ayarlari (docs/decisions/0074). Ortamdan YALNIZCA sunucuda
 * okunur; hicbiri `NEXT_PUBLIC_` degildir.
 *
 * `CHAT_DISCOVERY_ENABLED=true` verilmedikce ozellik kapalidir (varsayilan):
 * ana sayfa kutusu eskisi gibi `/ara`ya gider, `/sohbet` 404 doner. Hukuk
 * onayi gelmeden acilmaz (karar 0074 "Etkinlestirme kosulu").
 */
import { getLlmClient } from "../llm/gemini.ts";
import { QUOTA_POLICY, type WindowLimits } from "../quota/policy.ts";
import { type ChatInterpreter, GeminiChatInterpreter } from "./interpreter.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Saatlik sohbet mesaji (`quota/policy.ts`); `CHAT_TURNS_PER_HOUR` yalnizca saati ezer. */
export const DEFAULT_CHAT_TURNS_PER_HOUR = QUOTA_POLICY.chat_message.hour;
export const MAX_USER_MESSAGES_PER_CONVERSATION = 60;
export const USER_MESSAGE_MAX = 500;
export const CHAT_RETENTION_DAYS = 90;
export const CHAT_LEASE_SECONDS = 60;

export function isChatDiscoveryEnabled(env: Env = process.env): boolean {
  return env.CHAT_DISCOVERY_ENABLED?.trim() === "true";
}

/**
 * Sohbet gorsel eki (karar 0078). `CHAT_IMAGE_ENABLED=true` verilmedikce kapali;
 * hukuk onayi gelmeden acilmaz. Sohbetin kendisi de acik olmalidir.
 */
export function isChatImageEnabled(env: Env = process.env): boolean {
  return isChatDiscoveryEnabled(env) && env.CHAT_IMAGE_ENABLED?.trim() === "true";
}

/**
 * Sohbette ürün linki araması (karar 0079). `CHAT_LINK_ENABLED=true` verilmedikçe
 * kapalı (varsayılan): bağlantı içeren mesaj bugünkü gibi işlenir. Sohbetin
 * kendisi de açık olmalıdır. Link çözümü modelsizdir; hak/kuyruk `runChargedLinkSearch`.
 */
export function isChatLinkEnabled(env: Env = process.env): boolean {
  return isChatDiscoveryEnabled(env) && env.CHAT_LINK_ENABLED?.trim() === "true";
}

/**
 * Link tercihi metni için TEK Gemini çağrısı (karar 0079, kural 1 beşinci istisna).
 * Varsayılan kapalı; `CHAT_LINK_ENABLED` de açık olmalıdır.
 */
export function isChatLinkInterpretEnabled(env: Env = process.env): boolean {
  return isChatLinkEnabled(env) && env.CHAT_LINK_INTERPRET_ENABLED?.trim() === "true";
}

export function chatTurnsPerHour(env: Env = process.env): number {
  const parsed = Number.parseInt(env.CHAT_TURNS_PER_HOUR ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CHAT_TURNS_PER_HOUR;
  return Math.min(parsed, 200);
}

/** Sohbet mesaji havuzunun dort penceresi; saat `chatTurnsPerHour` ile ezilebilir. */
export function chatMessageLimits(env: Env = process.env): WindowLimits {
  return { ...QUOTA_POLICY.chat_message, hour: chatTurnsPerHour(env) };
}

/** `api_usage.operation`; `/ara` anlik yorumundan (`query_interpretation_realtime`) AYRI butce. */
export const CHAT_TURN_OPERATION = "chat_turn";

/** Europe/Istanbul gunu basina sohbet saglayici HTTP denemesi tavani (tum kullanicilar). */
export const CHAT_DAILY_CALL_CAP = 3000;

/**
 * Sohbet istemcisi: 12 sn x en cok 2 deneme (en kotu ~25 sn); sayfanin `maxDuration`
 * (60 sn) butcesi icinde kalir ve takili bir saglayici sunucu islemini uzun tutmaz.
 */
export const CHAT_CLIENT_OPTIONS = { timeoutMs: 12_000, maxAttempts: 2 } as const;

/** Anahtar yoksa `LlmError("missing_api_key")` atar; cagiran "saglayici hatasi" sayar. */
export function getChatInterpreter(env: Env = process.env): ChatInterpreter {
  return new GeminiChatInterpreter(getLlmClient(env, CHAT_CLIENT_OPTIONS));
}
