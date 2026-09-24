import { getUploadedImageEmbeddingForSearch, searchByImageVector } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState, SearchForm } from "@arilla/ui";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { verifySession } from "../../lib/dal.ts";
import { PhotoSearchButton } from "../../photo-search-client.tsx";
import styles from "../ara.module.css";
import { ResultGrid, resultCountLabel } from "../search-results.tsx";

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
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Fotoğrafına benzeyen ürünler</h1>
        {items.length > 0 ? (
          <p className={styles.count} role="status">
            {resultCountLabel(items.length)}
          </p>
        ) : null}
      </header>

      {items.length === 0 ? (
        <EmptyState
          className={styles.emptyPanel}
          title="Bu fotoğrafa benzeyen ürün bulamadık."
          description="Ürünün tek başına ve net göründüğü başka bir fotoğraf dene ya da ürünün adını yazarak ara."
          headingLevel={2}
        />
      ) : (
        <ResultGrid items={items} />
      )}

      <section className={styles.section} aria-labelledby="yeni-arama">
        <h2 id="yeni-arama" className={styles.sectionTitle}>
          Yeni bir arama yap
        </h2>
        <div className={styles.toolbar}>
          <div className={styles.toolbarSearch}>
            <SearchForm placeholder="Ürün adı, marka ya da kısa bir tarif yaz" submitLabel="Ara" />
          </div>
          <PhotoSearchButton />
        </div>
      </section>
    </div>
  );
}
