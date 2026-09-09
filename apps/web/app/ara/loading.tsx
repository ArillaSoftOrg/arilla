import { ProductCardSkeleton } from "@arilla/ui";

/**
 * Next.js'in yerlesik Suspense mekanizmasi: sayfa verisi hazir olana kadar
 * otomatik gosterilir. docs/pages.md: "Yükleniyor: iskelet kart, spinner
 * değil."
 */
export default function AramaLoading() {
  return (
    <main style={{ padding: 24, display: "grid", gap: 16 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          gap: 16,
        }}
      >
        {Array.from({ length: 24 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sabit sayida, sirasiz iskelet karti.
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    </main>
  );
}
