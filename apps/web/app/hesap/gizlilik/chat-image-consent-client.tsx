"use client";

import { useState } from "react";
import { withdrawChatImageConsentAction } from "../../sohbet/actions.ts";
import { CHAT_IMAGE_CONSENT_COPY as COPY } from "../../sohbet/chat-image-consent-copy.ts";
import styles from "./page.module.css";

/**
 * Karar 0101: sohbet fotografi izninin geri cekildigi yer. Burada IZIN VERILMEZ:
 * izin yalnizca bilgilendirme penceresinden (fotograf eklerken) verilebilir.
 */
export function ChatImageConsentWithdraw() {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");

  async function withdraw() {
    setState("pending");
    try {
      const { status } = await withdrawChatImageConsentAction();
      setState(status === "saved" ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <section className={styles.list} aria-labelledby="chat-image-consent-title">
      <h2 id="chat-image-consent-title" className={styles.itemTitle}>
        {COPY.settingsTitle}
      </h2>
      {state === "done" ? (
        <p className={styles.text} role="status">
          {COPY.settingsWithdrawn}
        </p>
      ) : (
        <>
          <p className={styles.text}>{COPY.settingsDescription}</p>
          <button type="button" disabled={state === "pending"} onClick={() => void withdraw()}>
            {COPY.settingsWithdraw}
          </button>
        </>
      )}
      {state === "error" ? (
        <p className={styles.text} role="alert">
          Tercihin kaydedilemedi. Biraz sonra tekrar dene.
        </p>
      ) : null}
    </section>
  );
}
