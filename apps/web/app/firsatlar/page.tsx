import { getDeals } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { Badge, EmptyState, formatTRY, ProductCard } from "@arilla/ui";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fırsatlar – Arilla",
  description: "Fiyatı düşen ürünler, düşüş tutarı ve yüzdesiyle.",
  alternates: { canonical: "/firsatlar" },
};

/**
 * docs/pages.md "/firsatlar": "Fiyatı düşen ürünler, günlük üretilir. Her
 * kartta düşüş tutarı ve yüzdesi. list_price_inflated işaretli ürünler bu
 * listeden düşürülür." (bkz. packages/core/src/discovery-feed/get-deals.ts)
 */
export default async function FirsatlarPage() {
  const deals = await getDeals(getDatabase());

  return (
    <main style={{ padding: 24, display: "grid", gap: 16 }}>
      <h1 style={{ margin: 0 }}>Fırsatlar</h1>
      {deals.length === 0 ? (
        <EmptyState title="Şu an öne çıkan bir fırsat yok." />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap: 16,
          }}
        >
          {deals.map((deal) => (
            <div key={deal.productId} style={{ display: "grid", gap: 4 }}>
              <ProductCard
                href={`/urun/${deal.slug}`}
                title={deal.title}
                imageUrl={deal.primaryImageUrl}
                minPrice={deal.currentPrice}
                offerCount={0}
                offerCountLabel={() => ""}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Badge>%{deal.savingsPercent} daha uygun</Badge>
                <span style={{ fontSize: 13, color: "var(--ink-muted)" }}>
                  {formatTRY(deal.savingsKurus)} tasarruf
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
