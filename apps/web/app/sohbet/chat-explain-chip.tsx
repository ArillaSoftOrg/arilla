"use client";

import { CHAT_COPY } from "./chat-copy.ts";
import { useChatProductTools } from "./chat-product-context.tsx";
import styles from "./sohbet.module.css";

/**
 * "Farkları açıkla" (karar 0203): mesaj kutusunu hazır bir soruyla doldurur; kullanıcı gönderir.
 * Otomatik gönderim YOKTUR (her model çağrısı kullanıcının kendi mesajıdır). Yanıt beklenirken
 * ya da bağlam yokken düğme pasiftir.
 */
export function ExplainChip() {
  const tools = useChatProductTools();
  if (!tools) return null;
  return (
    <button
      type="button"
      className={styles.restoreButton}
      disabled={tools.busy}
      onClick={() => tools.prepareMessage(CHAT_COPY.explainChipMessage)}
    >
      {CHAT_COPY.explainChip}
    </button>
  );
}
