"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../admin.module.css";
import { ConfirmButton } from "../../confirm-button-client.tsx";
import { cancelCampaignAction, processNextBatchAction } from "../actions.ts";

/**
 * Gönderim sürerken: sonraki partiyi hemen işle (cron'u beklemeden; yerelde
 * cron yok) ve iptal. İptal bekleyen teslimleri atlar; sağlayıcıya o anda
 * verilmekte olan ileti geri çağrılamaz.
 */
export function CampaignOpsClient({
  publicId,
  canProcess,
  canCancel,
}: {
  publicId: string;
  canProcess: boolean;
  canCancel: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function run(fn: () => Promise<{ ok: boolean; message?: string }>, done: string) {
    setPending(true);
    setMessage(null);
    try {
      const result = await fn();
      setMessage(
        result.ok
          ? { text: done, error: false }
          : { text: result.message ?? "İşlem yapılamadı.", error: true },
      );
      router.refresh();
    } catch {
      setMessage({ text: "İşlem yapılamadı. Tekrar dene.", error: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.pageHeader}>
      <div className={styles.row}>
        {canProcess ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                const result = await processNextBatchAction(publicId);
                return result.ok ? { ok: true } : { ok: false, message: result.message };
              }, "Parti işlendi.")
            }
          >
            Sonraki partiyi şimdi işle
          </Button>
        ) : null}
        {canCancel ? (
          <ConfirmButton
            label="Kampanyayı iptal et"
            title="Kampanyayı iptal et"
            description="Henüz gönderilmemiş alıcılara ileti gitmez. Gönderilmiş iletiler geri alınamaz. Bu işlem geri alınamaz."
            confirmLabel="İptal et"
            disabled={pending}
            onConfirm={() =>
              void run(() => cancelCampaignAction(publicId), "Kampanya iptal edildi.")
            }
          />
        ) : null}
      </div>
      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? styles.statusBad : styles.muted}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
