import {
  isRedisUnavailableError,
  type QueryObject,
  recordSearchAndCheckWall,
  resolveQuery,
  type SortMode,
  search,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { ClarificationBar, EmptyState, SortTabs } from "@arilla/ui";
import { cookies } from "next/headers";
import { verifySession } from "../lib/dal.ts";
import styles from "./ara.module.css";
import { ResultGrid, resultCountLabel } from "./search-results.tsx";
import { SearchWallGateClient } from "./search-wall-gate-client.tsx";

export const PAGE_SIZE = 24;

/**
 * Metin aramasinin sonuca bagli bolgesi: arama duvari, sonuc sayisi, kategori
 * netlestirme cubugu, siralama sekmeleri, izgara ve sayfalama.
 *
 * Sayfa bunu kendi `<Suspense>` sinirinin icinde cizer: arama kutusu,
 * netlestirme sorusu ve anlasilan cipler sonuc beklenirken yerinde kalir;
 * yalnizca bu bolge iskelete doner (docs/pages.md "Yükleniyor").
 */
export async function TextSearchResults({
  query,
  queryObject,
  isNewSearch,
  requestedSort,
  page,
  hrefFor,
}: {
  query: string;
  /** Konusma yolundan derlenmis sorgu; yoksa mevcut `resolveQuery` yolu. */
  queryObject: QueryObject | null;
  /** Arama duvari yalnizca yeni bir aramada sayilir, konusma adiminda degil. */
  isNewSearch: boolean;
  requestedSort: SortMode;
  page: number;
  hrefFor: (target: { sort: SortMode; page?: number }) => string;
}) {
  const db = getDatabase();

  // decision 0002: ilk N sorgu serbest, sonrasında modal. Girişi olanlar için
  // hiç sayılmaz; session_id proxy.ts tarafından garanti edilir ama bu istek
  // proxy'nin ilk kez yazdığı çerezi henüz görmüyor olabilir (Next: Server
  // Component render sırasında çerez okunur, o istekte YAZILAMAZ).
  let shouldShowWall = false;
  const user = await verifySession();
  if (!user && isNewSearch) {
    const sessionId = (await cookies()).get("session_id")?.value;
    if (sessionId) {
      // Arama duvari yalnizca surtunme (karar 0002): Redis erisilemezse arama
      // calismaya devam eder, duvar bu istekte atlanir ve durum loglanir.
      try {
        shouldShowWall = (await recordSearchAndCheckWall(sessionId)).shouldShowWall;
      } catch (error) {
        if (!isRedisUnavailableError(error)) throw error;
        console.error("[ara] search wall skipped: redis unavailable");
      }
    }
  }

  let parsed: QueryObject;
  let needsClarification = false;
  let candidateCategories: Awaited<ReturnType<typeof resolveQuery>>["candidateCategories"] = null;
  if (queryObject) {
    parsed = queryObject;
  } else {
    ({ parsed, needsClarification, candidateCategories } = await resolveQuery(db, query));
  }

  const hasAnchor = parsed.anchor !== null;
  // C1'in metin ayristiricisi her zaman anchor: null uretir (kapsami disinda);
  // C2'nin search()'u closest_match'i anchor'siz kabul etmez. Metin
  // aramasinda bu sekme bu yuzden her zaman devre disi.
  const effectiveSort: SortMode =
    requestedSort === "closest_match" && !hasAnchor ? "balanced" : requestedSort;

  const result = await search(
    db,
    { ...parsed, sort: effectiveSort },
    { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
  );

  let items = result.items;
  let isFallback = false;
  if (items.length === 0) {
    // docs/pages.md: "Boş sonuç: filtreleri gevşetme önerisi + en yakın 6
    // sonuç." Gevşetme icin kesin algoritma belirtilmemis; en basit ve
    // savunulabilir yorum: tum filtreleri temizle.
    const fallback = await search(db, { ...parsed, filters: {}, sort: "balanced" }, { limit: 6 });
    items = fallback.items;
    isFallback = true;
  }

  const tabs = [
    {
      value: "balanced",
      label: "Bizim seçtiklerimiz",
      href: hrefFor({ sort: "balanced" }),
      active: effectiveSort === "balanced",
    },
    {
      value: "best_deal",
      label: "En iyi fırsatlar",
      href: hrefFor({ sort: "best_deal" }),
      active: effectiveSort === "best_deal",
    },
    {
      value: "closest_match",
      label: "En yakın eşleşmeler",
      href: hrefFor({ sort: "closest_match" }),
      active: effectiveSort === "closest_match",
      disabled: !hasAnchor,
      disabledHint: "Bu arama için kullanılamıyor",
    },
  ];

  const totalPages = Math.ceil(result.total / PAGE_SIZE);

  return (
    <>
      <SearchWallGateClient show={shouldShowWall} />

      {!isFallback ? (
        <p id="sonuc-sayisi" className={styles.count} role="status">
          {resultCountLabel(result.total)}
        </p>
      ) : null}

      <div className={styles.controls}>
        {needsClarification && candidateCategories && candidateCategories.length > 0 ? (
          <ClarificationBar
            intro="Hangisini arıyorsun?"
            candidates={candidateCategories.map((id) => ({
              label: `Kategori ${id}`,
              href: `/ara?q=${encodeURIComponent(query)}&kategori=${id}`,
            }))}
            otherLabel="Başka bir şey"
            otherPlaceholder="Ne arıyorsun?"
            searchAction="/ara"
            queryParamName="q"
          />
        ) : null}

        <SortTabs tabs={tabs} />
      </div>

      {isFallback ? (
        <>
          <EmptyState
            className={styles.emptyPanel}
            title="Bu aramada sonuç bulamadık."
            description="Daha genel bir arama dene: fiyat, renk ya da beden gibi ayrıntıları çıkarabilir veya farklı kelimeler kullanabilirsin."
            headingLevel={2}
          />
          {items.length > 0 ? (
            <section className={styles.section} aria-labelledby="en-yakin-sonuclar">
              <h2 id="en-yakin-sonuclar" className={styles.sectionTitle}>
                Sana en yakın bulduklarımız
              </h2>
              <ResultGrid items={items} labelledBy="en-yakin-sonuclar" />
            </section>
          ) : null}
        </>
      ) : (
        <ResultGrid items={items} />
      )}

      {!isFallback && result.total > PAGE_SIZE ? (
        <nav className={styles.pagination} aria-label="Sayfalama">
          {page > 1 ? (
            <a
              href={hrefFor({ sort: effectiveSort, page: page - 1 })}
              rel="prev"
              className={styles.pageLink}
              aria-label="Önceki sayfa"
            >
              Önceki
            </a>
          ) : null}
          <p className={styles.pageStatus}>
            Sayfa {page} / {totalPages}
          </p>
          {page * PAGE_SIZE < result.total ? (
            <a
              href={hrefFor({ sort: effectiveSort, page: page + 1 })}
              rel="next"
              className={styles.pageLink}
              aria-label="Sonraki sayfa"
            >
              Sonraki
            </a>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
