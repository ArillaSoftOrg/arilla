"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { outcomeForNewChat } from "../home-image-chat.ts";
import { startChatBootstrapAction } from "./actions.ts";
import { browserStorage, takeBootstrap } from "./chat-bootstrap.ts";
import { browserImageStore, waitForImage } from "./chat-bootstrap-image.ts";
import { CHAT_COPY } from "./chat-copy.ts";
import { chatMark, setChatSubmittedAt } from "./chat-metrics.ts";
import { ChatComposer, ChatPendingRow, ChatUserRow } from "./chat-shell-parts.tsx";
import styles from "./sohbet.module.css";

type Phase = "starting" | "failed" | "missing";

/** Gonderilecek mesaj: metin, gorsel ya da ikisi (karar 0080). */
interface Submission {
  text: string;
  /** Yalniz gorselli mesaj. */
  image: { file: File; requestKey: string } | null;
}

/** Sunucu eylemine: metin-only duz metin (eski sozlesme), gorselli `FormData`. */
function toActionInput(submission: Submission): string | FormData {
  if (!submission.image) return submission.text;
  const data = new FormData();
  data.set("q", submission.text);
  data.set("photo", submission.image.file);
  data.set("requestKey", submission.image.requestKey);
  return data;
}

/**
 * `/sohbet/yeni` istemcisi. Mesaj ana sayfadan tek kullanimlik kayitla gelir
 * (URL'de degil); sunucuya TEK kez gonderilir. Basari -> `router.replace` ile
 * gercek URL (bootstrap history girisi birakmaz, geri tusu buraya donmez).
 * Hata -> kabuk kalir, "Tekrar dene" ayni mesaji yeniden gonderir.
 *
 * Karar 0080: gorselli mesaj AYNI kabuktan gecer. Gorsel IndexedDB'den gelir (ana sayfa
 * sekmeyi acar acmaz yazar; burada `waitForImage` ile beklenir), kullanici balonunda
 * metinle birlikte gorunur ve ayni eylemle gider. Sunucu yanit verdiginde gecici kayit silinir.
 */
export function ChatBootstrap() {
  const router = useRouter();
  const [text, setText] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(true);
  const startedRef = useRef(false);
  const inFlightRef = useRef(false);
  const submissionRef = useRef<Submission | null>(null);
  const nonceRef = useRef<string | null>(null);
  const imageUrlRef = useRef<string | null>(null);

  async function releaseStash(): Promise<void> {
    const nonce = nonceRef.current;
    if (nonce && submissionRef.current?.image) await browserImageStore()?.remove(nonce);
  }

  function fail(message: string | null, retry: boolean): void {
    setErrorMessage(message);
    setCanRetry(retry);
    setPhase("failed");
  }

  async function start(): Promise<void> {
    const submission = submissionRef.current;
    if (!submission || inFlightRef.current) return;
    inFlightRef.current = true;
    setPhase("starting");
    setErrorMessage(null);
    try {
      const result = await startChatBootstrapAction(toActionInput(submission));
      // Sunucu yanit verdi (basari ya da kesin hata): gecici gorsel kaydi artik gerekmez.
      await releaseStash();
      const outcome = outcomeForNewChat(result);
      if (outcome.kind === "navigate") {
        chatMark("chat:conversation_id");
        router.replace(outcome.href);
      } else if (outcome.kind === "fallback") {
        // Sohbet kapali / saatlik tavan (yalniz metin): yapay zekasiz arama yolu (mevcut davranis).
        window.location.replace(outcome.href);
      } else if (outcome.kind === "login") {
        fail(null, false);
      } else {
        // Metin mesajinda yalniz `error` gelir (varsayilan metin); gorselde anlasilir metin.
        fail(submission.image ? outcome.message : null, outcome.retry);
      }
    } catch {
      fail(null, true);
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
    nonceRef.current = nonce;
    const payload = takeBootstrap(browserStorage(), nonce);
    if (!payload) {
      setPhase("missing");
      return;
    }
    setChatSubmittedAt(payload.submittedAt);
    setText(payload.text);

    if (!payload.image || !nonce) {
      submissionRef.current = { text: payload.text, image: null };
      void start();
      return;
    }
    const requestKey = payload.image.requestKey;
    void (async () => {
      const store = browserImageStore();
      const blob = store ? await waitForImage(store, nonce) : null;
      if (!blob) {
        // Ana sayfa gorseli yazamadi / sure doldu: sessizce kaybolmaz, kullanici ana sayfaya doner.
        setPhase("missing");
        return;
      }
      const file = new File([blob], "photo", { type: blob.type });
      const url = URL.createObjectURL(file);
      imageUrlRef.current = url;
      setImageUrl(url);
      submissionRef.current = { text: payload.text, image: { file, requestKey } };
      void start();
    })();
  }, []);

  // Onizleme blob'u yalnizca sekme kapanirken serbest birakilir.
  useEffect(
    () => () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    },
    [],
  );

  return (
    <div className={styles.chat}>
      <ol
        className={styles.thread}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={CHAT_COPY.threadLabel}
      >
        {text !== null && (text !== "" || imageUrl) ? (
          <ChatUserRow text={text} imageSrc={imageUrl} />
        ) : null}
      </ol>

      {phase === "starting" && text !== null ? <ChatPendingRow /> : null}

      {phase !== "starting" ? (
        <div className={styles.error} role="alert">
          <p className={styles.errorMessage}>{errorMessage ?? CHAT_COPY.startFailed}</p>
          <div className={styles.errorActions}>
            {phase === "failed" && canRetry && submissionRef.current ? (
              <Button variant="accent" onClick={() => void start()}>
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
