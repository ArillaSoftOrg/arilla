"use client";

import { HeartIcon, ProductCard } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { removeSavedItemAction } from "./actions.ts";
import styles from "./page.module.css";
import { SAVED_COPY } from "./saved-copy.ts";

export interface SavedItemsListClientItem {
  productId: number;
  slug: string;
  title: string;
  primaryImageUrl: string | null;
  minPrice: number | null;
  offerCount: number;
}

/**
 * Kayitli urun izgarasi. Kalp dugmesi kartin ustunde (baglantinin kardesi,
 * tiklamasi gezinmez) ve mevcut `removeSavedItemAction`'i cagirir; kalicilik
 * ve yetki sunucuda ayni kalir. Basarida liste sunucudan yenilenir.
 */
export function SavedItemsListClient({ items }: { items: SavedItemsListClientItem[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove(productId: number) {
    if (pendingId !== null) return;
    setPendingId(productId);
    setError(null);
    try {
      await removeSavedItemAction(productId);
      router.refresh();
    } catch {
      setError(SAVED_COPY.removeError);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <p className={styles.status} role="status" aria-live="polite">
        {error}
      </p>
      {/* biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur. */}
      <ul role="list" className={styles.grid}>
        {items.map((item) => {
          const pending = pendingId === item.productId;
          return (
            <li key={item.productId} className={styles.item}>
              <ProductCard
                href={`/urun/${item.slug}`}
                title={item.title}
                imageUrl={item.primaryImageUrl}
                minPrice={item.minPrice}
                offerCount={item.offerCount}
                offerCountLabel={SAVED_COPY.offerCount}
                action={
                  <button
                    type="button"
                    className={styles.saveToggle}
                    aria-label={SAVED_COPY.remove(item.title)}
                    aria-pressed="true"
                    aria-busy={pending || undefined}
                    disabled={pending}
                    onClick={() => handleRemove(item.productId)}
                  >
                    <HeartIcon filled size={20} />
                  </button>
                }
              />
            </li>
          );
        })}
      </ul>
    </>
  );
}
