"use client";

import { Badge, Button, Card, formatTRY } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
    <div style={{ display: "grid", gap: 12 }}>
      {items.map((item) => {
        const detail = detailText(item);
        return (
          <Card
            key={item.alertId}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: 16 }}
          >
            {item.primaryImageUrl ? (
              // biome-ignore lint/performance/noImgElement: urun/[slug]/page.tsx ile ayni desen.
              <img
                src={item.primaryImageUrl}
                alt=""
                style={{ width: 56, height: 56, objectFit: "cover", background: "var(--surface)" }}
              />
            ) : (
              <div
                style={{ width: 56, height: 56, background: "var(--surface)" }}
                aria-hidden="true"
              />
            )}
            <div style={{ flex: 1, display: "grid", gap: 4 }}>
              <a href={`/urun/${item.slug}`} style={{ fontWeight: 600 }}>
                {item.title}
              </a>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Badge>{KIND_LABEL[item.kind]}</Badge>
                {!item.isActive ? <Badge>Gönderildi</Badge> : null}
                {detail ? (
                  <span style={{ fontSize: 13, color: "var(--ink-muted)" }}>{detail}</span>
                ) : null}
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={pendingId === item.alertId}
              onClick={() => handleDelete(item.alertId)}
            >
              Kaldır
            </Button>
          </Card>
        );
      })}
    </div>
  );
}
