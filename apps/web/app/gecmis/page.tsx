import { listHistory } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState, ProductCard } from "@arilla/ui";
import { requireUser } from "../lib/dal.ts";
import { ClearHistoryButtonClient } from "./clear-history-button-client.tsx";

/**
 * docs/pages.md: "Üçü de aynı kalıp: başlık, liste, boş durum." Liste
 * yalnızca E3'ten sonra dolmaya başlar - bkz. `packages/core/src/account/
 * history.ts` başlığı (product_view yazımı rıza bekliyor).
 */
export default async function GecmisPage() {
  const user = await requireUser();
  const items = await listHistory(getDatabase(), user.id);

  return (
    <main style={{ padding: 24, display: "grid", gap: 16, maxWidth: 960 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ margin: 0 }}>Geçmişim</h1>
        {items.length > 0 ? <ClearHistoryButtonClient /> : null}
      </div>
      {items.length === 0 ? (
        <EmptyState title="Henüz gezindiğin ürün yok." />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap: 16,
          }}
        >
          {items.map((item) => (
            <ProductCard
              key={item.productId}
              href={`/urun/${item.slug}`}
              title={item.title}
              imageUrl={item.primaryImageUrl}
              minPrice={item.minPrice}
              offerCount={item.offerCount}
              offerCountLabel={(count) => `${count} mağaza`}
            />
          ))}
        </div>
      )}
    </main>
  );
}
