/**
 * Sohbet gecikme olcumu (karar 0074 ekleri). YALNIZCA sure ve sabit etiket tasir:
 * mesaj metni, asistan metni, sorgu, kullanici kimligi ve anahtar bu module hic girmez.
 *
 * Sunucu satiri tek JSON: `[sohbet] timing {"op":"turn","outcome":"answered","chat.gemini":412,...}`.
 * `CHAT_TIMING_LOG=true` degilse yazilmaz (varsayilan kapali, log gurultusu yok);
 * olcumler yine de sonuc nesnesinde doner, benchmark betikleri bunu okur.
 * p50/p75/p95: satirlar `chat.*` anahtarlariyla gruplanip hesaplanir.
 */

export const CHAT_TIMING_NAMES = [
  "total",
  "create_conversation",
  "session",
  "claim_turn",
  "load_context",
  "provider_limit",
  "lexicon",
  "gemini",
  "link_turn",
  "persist",
  "search",
] as const;
export type ChatTimingName = (typeof CHAT_TIMING_NAMES)[number];
export type ChatTimings = Partial<Record<`chat.${ChatTimingName}`, number>>;

export interface ChatTimer {
  /** `fn` sonucunu aynen doner (hata da aynen); sure hata olsa da yazilir. */
  time<T>(name: ChatTimingName, fn: () => Promise<T>): Promise<T>;
  /** Toplam sureyi (`chat.total`) ekleyip ms tamsayi olcumleri doner. */
  finish(): ChatTimings;
}

export function createChatTimer(now: () => number = () => performance.now()): ChatTimer {
  const startedAt = now();
  const durations: ChatTimings = {};
  return {
    async time(name, fn) {
      const begin = now();
      try {
        return await fn();
      } finally {
        const key = `chat.${name}` as const;
        durations[key] = (durations[key] ?? 0) + (now() - begin);
      }
    },
    finish() {
      const out: ChatTimings = { ...durations, "chat.total": now() - startedAt };
      for (const key of Object.keys(out) as (keyof ChatTimings)[]) {
        out[key] = Math.round(out[key] ?? 0);
      }
      return out;
    },
  };
}

type Env = Readonly<Record<string, string | undefined>>;

export function isChatTimingLogEnabled(env: Env = process.env): boolean {
  return env.CHAT_TIMING_LOG?.trim() === "true";
}

export function logChatTimings(
  op: string,
  outcome: string,
  timings: ChatTimings,
  env: Env = process.env,
  write: (line: string) => void = (line) => console.info(line),
): void {
  if (!isChatTimingLogEnabled(env)) return;
  write(`[sohbet] timing ${JSON.stringify({ op, outcome, ...timings })}`);
}
