import { getDiscoverySlots, todaySlotDate } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState, ProductCard } from "@arilla/ui";

/**
 * docs/pages.md "/kesfet": "Bugün öne çıkanlar" (curated) -> "Kullanıcıların
 * bulduğu" (organic, yalnızca kayıt varsa) -> creator koleksiyonları.
 * Creator koleksiyonları bölümü burada yok - F bloğu (MVP-2) henüz
 * başlamadı, docs/backlog.md kendisi "MVP-1 metrikleri doğrulandıktan
 * sonra detaylandırılır" diyor.
 */
export default async function KesfetPage() {
  const db = getDatabase();
  const items = await getDiscoverySlots(db, todaySlotDate());

  if (items.length === 0) {
    return (
      <main style={{ padding: 24 }}>
        <EmptyState title="Bugünlük içerik hazırlanıyor." />
      </main>
    );
  }

  const curated = items.filter((item) => item.source === "curated");
  const organic = items.filter((item) => item.source === "organic");

  return (
    <main style={{ padding: 24, display: "grid", gap: 32 }}>
      <section style={{ display: "grid", gap: 16 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Bugün öne çıkanlar</h1>
        <div style={{ columnWidth: 200, columnGap: 16 }}>
          {curated.map((item) => (
            <div key={item.productId} style={{ breakInside: "avoid", marginBottom: 16 }}>
              <ProductCard
                href={`/urun/${item.slug}`}
                title={item.title}
                imageUrl={item.primaryImageUrl}
                minPrice={item.minPrice}
                offerCount={item.offerCount}
                offerCountLabel={(count) => `${count} mağaza`}
              />
            </div>
          ))}
        </div>
      </section>

      {organic.length > 0 ? (
        <section style={{ display: "grid", gap: 16 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>Kullanıcıların bulduğu</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: 16,
            }}
          >
            {organic.map((item) => (
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
        </section>
      ) : null}
    </main>
  );
}
