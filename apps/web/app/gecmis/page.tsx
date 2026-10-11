import { listHistory } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState, ProductCard } from "@arilla/ui";
import type { Metadata } from "next";
import styles from "../account-list-page.module.css";
import { requireProductUser } from "../lib/dal.ts";
import { ClearHistoryButtonClient } from "./clear-history-button-client.tsx";

export const metadata: Metadata = {
  title: "Geçmişim",
  robots: { index: false, follow: false },
};

/**
 * docs/pages.md: "Üçü de aynı kalıp: başlık, liste, boş durum." Liste
 * yalnızca E3'ten sonra dolmaya başlar - bkz. `packages/core/src/account/
 * history.ts` başlığı (product_view yazımı rıza bekliyor).
 */
export default async function GecmisPage() {
  const user = await requireProductUser();
  const items = await listHistory(getDatabase(), user.id);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Geçmişim</h1>
        {items.length > 0 ? <ClearHistoryButtonClient /> : null}
      </div>
      {items.length === 0 ? (
        <EmptyState title="Henüz gezindiğin ürün yok." />
      ) : (
        // biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur.
        <ul role="list" className={styles.grid}>
          {items.map((item) => (
            <li key={item.productId} className={styles.gridItem}>
              <ProductCard
                href={`/urun/${item.slug}`}
                title={item.title}
                imageUrl={item.primaryImageUrl}
                minPrice={item.minPrice}
                offerCount={item.offerCount}
                offerCountLabel={(count) => `${count} mağaza`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
