"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import styles from "../admin.module.css";
import { AdminDialog, DialogActions } from "../admin-dialog-client.tsx";
import { trendStatusLabel } from "../format.ts";
import {
  moveTrendAction,
  setTrendFeaturedAction,
  setTrendStatusAction,
  type TrendActionResult,
} from "./actions.ts";

export interface TrendRowControls {
  id: number;
  title: string;
  status: string;
  featured: boolean;
  /** Bu durumdan izinli geçişler (sunucuda hesaplanır, core aynı kuralı ayrıca uygular). */
  transitions: string[];
  belowThreshold: boolean;
  isFirst: boolean;
  isLast: boolean;
}

type Operation =
  | { kind: "status"; next: string }
  | { kind: "featured"; featured: boolean }
  | { kind: "move"; direction: "up" | "down" };

function operationLabel(op: Operation): string {
  if (op.kind === "status") {
    if (op.next === "published") return "Yayınla";
    if (op.next === "archived") return "Arşivle";
    return "Taslağa al (yayından kaldır)";
  }
  if (op.kind === "featured") return op.featured ? "Öne çıkar" : "Öne çıkarmayı kaldır";
  return op.direction === "up" ? "Sırada yukarı taşı" : "Sırada aşağı taşı";
}

/**
 * Trend satırı işlemleri (karar 0086). Her işlem gerekçe ister (5–500);
 * sunucu taze giriş, yetki, satır kilidi ve denetimi ayrıca uygular.
 */
export function TrendActionsClient({ row }: { row: TrendRowControls }) {
  const router = useRouter();
  const reasonId = useId();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TrendActionResult | null>(null);
  const operations: Operation[] = [
    ...row.transitions.map((next) => ({ kind: "status" as const, next })),
    { kind: "featured", featured: !row.featured },
    ...(row.isFirst ? [] : [{ kind: "move" as const, direction: "up" as const }]),
    ...(row.isLast ? [] : [{ kind: "move" as const, direction: "down" as const }]),
  ];
  const [selected, setSelected] = useState(0);
  const [reason, setReason] = useState("");
  const op = operations[selected] ?? operations[0];

  function run(close: () => void) {
    if (!op) return;
    startTransition(async () => {
      const response =
        op.kind === "status"
          ? await setTrendStatusAction({
              trendId: row.id,
              next: op.next,
              expectedStatus: row.status,
              reason,
            })
          : op.kind === "featured"
            ? await setTrendFeaturedAction({ trendId: row.id, featured: op.featured, reason })
            : await moveTrendAction({ trendId: row.id, direction: op.direction, reason });
      setResult(response);
      if (response.ok) {
        setReason("");
        close();
        router.refresh();
      }
    });
  }

  return (
    <AdminDialog
      triggerLabel="Değiştir"
      title={`Trend: ${row.title}`}
      description={`Durum: ${trendStatusLabel(row.status)}. Değişiklik kamuya açık /trendler sayfasını etkiler ve denetim kaydına yazılır.`}
    >
      {(close) => (
        <form
          className={styles.formGrid}
          onSubmit={(event) => {
            event.preventDefault();
            run(close);
          }}
        >
          <fieldset className={styles.formGrid}>
            <legend className={styles.filterLabel}>İşlem</legend>
            {operations.map((candidate, index) => (
              <label key={operationLabel(candidate)}>
                <span className={styles.row}>
                  <input
                    type="radio"
                    name="islem"
                    checked={index === selected}
                    onChange={() => setSelected(index)}
                  />
                  {operationLabel(candidate)}
                </span>
              </label>
            ))}
          </fieldset>
          {op?.kind === "status" && op.next === "published" && row.belowThreshold ? (
            <p className={styles.statusWarn}>
              Gösterilebilir ürün eşiğin altında: yayınlansa da /trendler'de görünmez.
            </p>
          ) : null}
          <label htmlFor={reasonId}>
            <span className={styles.filterLabel}>Gerekçe (zorunlu, 5–500 karakter)</span>
            <textarea
              id={reasonId}
              className={styles.textArea}
              style={{ minHeight: "6rem" }}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={5}
              maxLength={500}
              required
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
