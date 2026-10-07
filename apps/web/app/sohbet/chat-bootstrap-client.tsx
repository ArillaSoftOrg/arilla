"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { startChatBootstrapAction } from "./actions.ts";
import { browserStorage, takeBootstrap } from "./chat-bootstrap.ts";
import { CHAT_COPY } from "./chat-copy.ts";
import { chatMark, setChatSubmittedAt } from "./chat-metrics.ts";
import { ChatComposer, ChatPendingRow, ChatUserRow } from "./chat-shell-parts.tsx";
import styles from "./sohbet.module.css";

type Phase = "starting" | "failed" | "missing";

/**
 * `/sohbet/yeni` istemcisi. Mesaj ana sayfadan tek kullanimlik kayitla gelir
 * (URL'de degil); sunucuya TEK kez gonderilir. Basari -> `router.replace` ile
 * gercek URL (bootstrap history girisi birakmaz, geri tusu buraya donmez).
 * Hata -> kabuk kalir, "Tekrar dene" ayni mesaji yeniden gonderir.
 */
export function ChatBootstrap() {
  const router = useRouter();
  const [text, setText] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const startedRef = useRef(false);
  const inFlightRef = useRef(false);

  async function start(message: string): Promise<void> {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase("starting");
    try {
      const result = await startChatBootstrapAction(message);
      if (result.status === "error") {
        setPhase("failed");
        return;
      }
      chatMark("chat:conversation_id");
      if (result.status === "created") router.replace(result.href);
      // Sohbet kapali / saatlik tavan: yapay zekasiz arama yolu (mevcut davranis).
      else window.location.replace(result.href);
    } catch {
      setPhase("failed");
    } finally {
      inFlightRef.current = false;
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: yalnizca bir kez, ilk yuklemede.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    chatMark("chat:shell_visible");
    try {
      // Bu sekme ana sayfaya erisemesin.
      window.opener = null;
    } catch {
      // Salt okunur olabilir.
    }
    const nonce = new URLSearchParams(window.location.search).get("n");
    const payload = takeBootstrap(browserStorage(), nonce);
    if (!payload) {
      setPhase("missing");
      return;
    }
    setChatSubmittedAt(payload.submittedAt);
    setText(payload.text);
    void start(payload.text);
  }, []);

  return (
    <div className={styles.chat}>
      <ol
        className={styles.thread}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={CHAT_COPY.threadLabel}
      >
        {text ? <ChatUserRow text={text} /> : null}
      </ol>

      {phase === "starting" && text ? <ChatPendingRow /> : null}

      {phase !== "starting" ? (
        <div className={styles.error} role="alert">
          <p className={styles.errorMessage}>{CHAT_COPY.startFailed}</p>
          <div className={styles.errorActions}>
            {phase === "failed" && text ? (
              <Button variant="accent" onClick={() => void start(text)}>
                {CHAT_COPY.retryLabel}
              </Button>
            ) : (
              <a className={styles.errorLink} href="/">
                {CHAT_COPY.backHomeLabel}
              </a>
            )}
          </div>
        </div>
      ) : null}

      <div className={styles.bottom} aria-hidden="true" />
      <ChatComposer draft="" locked />
    </div>
  );
}
