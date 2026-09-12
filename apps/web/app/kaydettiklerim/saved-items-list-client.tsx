"use client";

import { Button, ProductCard } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { removeSavedItemAction } from "./actions.ts";

export interface SavedItemsListClientItem {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  minPrice: number | null;
  offerCount: number;
}

export function SavedItemsListClient({ items }: { items: SavedItemsListClientItem[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<number | null>(null);

  async function handleRemove(productId: number) {
    setPendingId(productId);
    try {
      await removeSavedItemAction(productId);
      router.refresh();
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
        gap: 16,
      }}
    >
      {items.map((item) => (
        <div key={item.productId} style={{ display: "grid", gap: 8 }}>
          <ProductCard
            href={`/urun/${item.slug}`}
            title={item.title}
            imageUrl={item.primaryImageUrl}
            minPrice={item.minPrice}
            offerCount={item.offerCount}
            offerCountLabel={(count) => `${count} mağaza`}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={pendingId === item.productId}
            onClick={() => handleRemove(item.productId)}
          >
            Kaldır
          </Button>
        </div>
      ))}
    </div>
  );
}
