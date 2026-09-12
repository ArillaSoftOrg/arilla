import { ProductCardSkeleton } from "@arilla/ui";

/** docs/pages.md: "Görsel aramada iskelet kartlar sonuç gelene kadar durur." */
export default function GorselAramaLoading() {
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
