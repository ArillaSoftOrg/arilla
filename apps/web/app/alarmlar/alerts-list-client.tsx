"use client";

import { Badge, Button, formatTRY, ProductImage } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../account-list-page.module.css";
import { deleteAlertAction } from "./actions.ts";

export interface AlertsListClientItem {
  alertId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  kind: "price_drop" | "any_drop" | "restock" | "size_restock";
  targetPrice: number | null;
  sizeNorm: string | null;
  isActive: boolean;
}

const KIND_LABEL: Record<AlertsListClientItem["kind"], string> = {
  price_drop: "Fiyat",
  any_drop: "Fiyat",
  restock: "Stok",
  size_restock: "Beden",
};

function detailText(item: AlertsListClientItem): string | null {
  if (item.kind === "price_drop" && item.targetPrice !== null) {
    return `${formatTRY(item.targetPrice)} altına düşünce`;
  }
  if (item.kind === "size_restock" && item.sizeNorm) {
    return `${item.sizeNorm} bedeni gelince`;
  }
  return null;
}

export function AlertsListClient({ items }: { items: AlertsListClientItem[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<number | null>(null);

  async function handleDelete(alertId: number) {
    setPendingId(alertId);
    try {
      await deleteAlertAction(alertId);
      router.refresh();
    } finally {
      setPendingId(null);
    }
  }

  return (
    // biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur.
    <ul role="list" className={styles.alertList}>
      {items.map((item) => {
        const detail = detailText(item);
        return (
          <li key={item.alertId} className={styles.alertRow}>
            <span className={styles.alertThumb} aria-hidden="true">
              {item.primaryImageUrl ? (
                <ProductImage
                  src={item.primaryImageUrl}
                  alt=""
                  fit="contain"
                  className={styles.alertThumbImage}
                />
              ) : null}
            </span>
            <div className={styles.alertBody}>
              <a href={`/urun/${item.slug}`} className={styles.alertTitle}>
                {item.title}
              </a>
              <div className={styles.alertMeta}>
                <Badge>{KIND_LABEL[item.kind]}</Badge>
                {!item.isActive ? <Badge>Gönderildi</Badge> : null}
                {detail ? <span className={styles.alertDetail}>{detail}</span> : null}
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              className={styles.alertAction}
              disabled={pendingId === item.alertId}
              onClick={() => handleDelete(item.alertId)}
            >
              Kaldır
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
