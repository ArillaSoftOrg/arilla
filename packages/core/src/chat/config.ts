/**
 * Konusmali kesif ayarlari (docs/decisions/0074). Ortamdan YALNIZCA sunucuda
 * okunur; hicbiri `NEXT_PUBLIC_` degildir.
 *
 * `CHAT_DISCOVERY_ENABLED=true` verilmedikce ozellik kapalidir (varsayilan):
 * ana sayfa kutusu eskisi gibi `/ara`ya gider, `/sohbet` 404 doner. Hukuk
 * onayi gelmeden acilmaz (karar 0074 "Etkinlestirme kosulu").
 */
import { getLlmClient } from "../llm/gemini.ts";
import { type ChatInterpreter, GeminiChatInterpreter } from "./interpreter.ts";

type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_CHAT_TURNS_PER_HOUR = 20;
export const MAX_USER_MESSAGES_PER_CONVERSATION = 60;
export const USER_MESSAGE_MAX = 500;
export const CHAT_RETENTION_DAYS = 90;
export const CHAT_LEASE_SECONDS = 60;

export function isChatDiscoveryEnabled(env: Env = process.env): boolean {
  return env.CHAT_DISCOVERY_ENABLED?.trim() === "true";
}

export function chatTurnsPerHour(env: Env = process.env): number {
  const parsed = Number.parseInt(env.CHAT_TURNS_PER_HOUR ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CHAT_TURNS_PER_HOUR;
  return Math.min(parsed, 200);
}

/** Anahtar yoksa `LlmError("missing_api_key")` atar; cagiran "saglayici hatasi" sayar. */
export function getChatInterpreter(env: Env = process.env): ChatInterpreter {
  return new GeminiChatInterpreter(getLlmClient(env));
}
