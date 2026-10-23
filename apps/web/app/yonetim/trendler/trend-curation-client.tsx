"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import styles from "../admin.module.css";
import { AdminDialog, DialogActions } from "../admin-dialog-client.tsx";
import { trendCurationLabel } from "../format.ts";
import { setTrendCurationAction, type TrendActionResult } from "./actions.ts";

/**
 * Koleksiyon türü (karar 0147/0149): elle seçilmiş ↔ otomatik. Bağlar bu işlemde değişmez.
 * Otomatiğe geçişte bir sonraki `curate --apply` ürünleri kendi seçimiyle yeniden yazar.
 */
export function TrendCurationClient({ trendId, curation }: { trendId: number; curation: string }) {
  const router = useRouter();
  const reasonId = useId();
  const next = curation === "manual" ? "auto" : "manual";
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<TrendActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <AdminDialog
      triggerLabel={`${trendCurationLabel(next)} yap`}
      title={`Koleksiyon türü: ${trendCurationLabel(next)}`}
      description={
        next === "auto"
          ? "Otomatik küratör bir sonraki çalıştırmada ürünleri kendi seçimiyle yeniden yazar; elle yapılan seçim kaybolur."
          : "Mevcut ürünler korunur; otomatik küratör bu koleksiyona artık dokunmaz. Ürünleri bu ekrandan yönetirsin."
      }
    >
      {(close) => (
        <form
          className={styles.formGrid}
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              const response = await setTrendCurationAction({
                trendId,
                next,
                expected: curation,
                reason,
              });
              setResult(response);
              if (response.ok) {
                setReason("");
                close();
                router.refresh();
              }
            });
          }}
        >
          <label htmlFor={reasonId}>
            <span className={styles.filterLabel}>Gerekçe (zorunlu, 5–500 karakter)</span>
            <textarea
              id={reasonId}
              className={styles.textArea}
              required
              minLength={5}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div aria-live="polite">
            {result && !result.ok ? (
              <p className={styles.statusBad} role="alert">
                {result.message}{" "}
                {result.reauthHref ? <a href={result.reauthHref}>Yeniden giriş yap</a> : null}
              </p>
            ) : null}
          </div>
          <DialogActions>
            <Button type="button" variant="secondary" onClick={close}>
              Vazgeç
            </Button>
            <Button type="submit" variant="primary" disabled={pending || reason.trim().length < 5}>
              {pending ? "Uygulanıyor…" : "Uygula"}
            </Button>
          </DialogActions>
        </form>
      )}
    </AdminDialog>
  );
}
