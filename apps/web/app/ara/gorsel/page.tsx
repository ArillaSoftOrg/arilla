import { getUploadedImageEmbeddingForSearch, searchByImageVector } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { ProductCard } from "@arilla/ui";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { verifySession } from "../../lib/dal.ts";

interface GorselSearchParams {
  id?: string;
}

/**
 * docs/routes.md "/ara/gorsel": görsel arama sonucu. Yükleme (embedding
 * üretimi) `actions.ts`'te senkron bitiyor - burada beklenen tek şey bu
 * sayfanın kendi render süresi, `link_resolution_request`'in aksine ayrı
 * bir bekleme/poll mekanizması yok.
 */
export default async function GorselAramaPage({
  searchParams,
}: {
  searchParams: Promise<GorselSearchParams>;
}) {
  const { id } = await searchParams;
  const imageUploadId = id ? Number(id) : Number.NaN;
  if (!Number.isInteger(imageUploadId)) notFound();

  const db = getDatabase();
  const user = await verifySession();
  const sessionId = (await cookies()).get("session_id")?.value ?? null;

  const queryEmbedding = await getUploadedImageEmbeddingForSearch(db, {
    imageUploadId,
    sessionId,
    userId: user?.id ?? null,
  });
  if (!queryEmbedding) notFound();

  const items = await searchByImageVector(db, queryEmbedding.vector, queryEmbedding.modelVersion);

  return (
    <main style={{ padding: 24, display: "grid", gap: 16 }}>
      {items.length === 0 ? (
        <p>Bu aramada sonuç bulamadık. Filtreleri gevşetmeyi deneyebilirsin.</p>
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
