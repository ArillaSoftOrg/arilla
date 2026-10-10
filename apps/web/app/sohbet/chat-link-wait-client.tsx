"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { pollChatLinkAction } from "./actions.ts";
import { CHAT_LINK_COPY } from "./chat-copy.ts";
import styles from "./sohbet.module.css";

const POLL_INTERVAL_MS = 2000;
/** Çekirdek 2 dakikada işi bayat sayar; istemci de en geç bundan sonra bırakır. */
const CLIENT_TIMEOUT_MS = 150_000;

/**
 * Bekleyen link incelemesi: kısa aralıkla "bitti mi?" sorar, bitince sunucu
 * bileşenini yeniden çizer (`router.refresh`). Hak uzlaşması çekirdekte
 * (`getChatLinkView`). Sonsuz bekleme yok: süre dolunca yenileme bağlantısı.
 */
export function ChatLinkWaitClient({
  conversationId,
  messageSeq,
}: {
  conversationId: string;
  messageSeq: number;
}) {
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + CLIENT_TIMEOUT_MS;

    function schedule() {
      timer = setTimeout(async () => {
        if (cancelled) return;
        let state: Awaited<ReturnType<typeof pollChatLinkAction>>["state"] = "pending";
        try {
          ({ state } = await pollChatLinkAction(conversationId, messageSeq));
        } catch {
          state = "pending";
        }
        if (cancelled) return;
        if (state !== "pending") {
          router.refresh();
          return;
        }
        if (Date.now() > deadline) {
          setTimedOut(true);
          return;
        }
        schedule();
      }, POLL_INTERVAL_MS);
    }
    schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [conversationId, messageSeq, router]);

  return (
    <div className={styles.results} data-link-state="pending" aria-busy={!timedOut}>
      <p className={styles.resultsHeading} role="status" aria-live="polite">
        {timedOut ? CHAT_LINK_COPY.waitTimedOut : CHAT_LINK_COPY.pendingTitle}
      </p>
      {timedOut ? (
        <a className={styles.seeAll} href={`/sohbet/${conversationId}`}>
          {CHAT_LINK_COPY.reloadLabel}
        </a>
      ) : (
        <p className={styles.resultsNote}>{CHAT_LINK_COPY.pendingDescription}</p>
      )}
    </div>
  );
}
