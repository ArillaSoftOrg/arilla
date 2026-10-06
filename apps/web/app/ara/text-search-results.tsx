import {
  createPostgresSearchProvider,
  createSeedAliasSource,
  formatTraceForLog,
  isRedisUnavailableError,
  type QueryObject,
  recordActivity,
  recordSearchAndCheckWall,
  recordTextSearchQuality,
  resolveQuery,
  type SortMode,
  searchWithFallback,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { ClarificationBar, SortTabs } from "@arilla/ui";
import { cookies } from "next/headers";
import { after } from "next/server";
import { readConsent } from "../lib/consent.ts";
import { verifySession } from "../lib/dal.ts";
import styles from "./ara.module.css";
import { SearchFallbackResults, SearchNoResults } from "./search-fallback-results.tsx";
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
  clarificationAsked = false,
}: {
  query: string;
  /** Konusma yolundan derlenmis sorgu; yoksa mevcut `resolveQuery` yolu. */
  queryObject: QueryObject | null;
  /** Arama duvari yalnizca yeni bir aramada sayilir, konusma adiminda degil. */
  isNewSearch: boolean;
  requestedSort: SortMode;
  page: number;
  hrefFor: (target: { sort: SortMode; page?: number }) => string;
  /** Konuşma planı bu aramada netleştirme sorusu sordu (arama kalitesi sayacı). */
  clarificationAsked?: boolean;
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
  let parserTier: number | null = null;
  let needsClarification = false;
  let candidateCategories: Awaited<ReturnType<typeof resolveQuery>>["candidateCategories"] = null;
  if (queryObject) {
    parsed = queryObject;
  } else {
    ({ parsed, parserTier, needsClarification, candidateCategories } = await resolveQuery(
      db,
      query,
    ));
  }

  const hasAnchor = parsed.anchor !== null;
  // C1'in metin ayristiricisi her zaman anchor: null uretir (kapsami disinda);
  // C2'nin search()'u closest_match'i anchor'siz kabul etmez. Metin
  // aramasinda bu sekme bu yuzden her zaman devre disi.
  const effectiveSort: SortMode =
    requestedSort === "closest_match" && !hasAnchor ? "balanced" : requestedSort;

  // Yapay zekasiz asamali arama (docs/decisions/0066): once mevcut yol; sonuc yoksa
  // ya da yalnizca model kodu celiskili urunler varsa kontrollu gevsetme. Istek
  // yolunda model cagrisi yok.
  const outcome = await searchWithFallback(
    createPostgresSearchProvider(db),
    { parsed: { ...parsed, sort: effectiveSort }, sort: effectiveSort, page, pageSize: PAGE_SIZE },
    {
      aliases: createSeedAliasSource(),
      onTrace: (trace) => {
        // Sorgu metni loga girmez (kisisel veri); yalnizca sayi ve sabit kodlar.
        if (trace.mode !== "results" || trace.stage !== "exact") {
          console.info(formatTraceForLog(trace));
        }
      },
    },
  );
  const isFallback = outcome.mode === "fallback";
  const items = outcome.items;
  // Yakin sonuclar "sonuc" sayilmaz: sayac ve analitik gercek eslesmeyi olcer.
  const resultTotal = outcome.mode === "results" ? outcome.total : 0;

  // 0049 §7: rızalı davranışsal analitik. Yalnızca girişli kullanıcıda, yeni
  // bir aramanın ilk sayfasında. Rıza kapısı ve tekrar bastırma core'da.
  // Analitik hatası aramayı asla bozmaz.
  if (user && isNewSearch && page === 1) {
    try {
      await recordActivity(db, {
        userId: user.id,
        cookieConsent: await readConsent(),
        event: { kind: "search_submitted", query, resultCount: resultTotal },
      });
    } catch (error) {
      console.error("[ara] activity failed", error instanceof Error ? error.name : "unknown");
    }
  }

  // Karar 0054: kimliksiz günlük arama kalitesi özeti (`search_query_day`).
  // Analitik olayı değil, rızaya bağlı değil; kişisel veri içeren sorgu core'da
  // hiç yazılmaz. Yalnızca yeni aramanın varsayılan sekmedeki ilk sayfası
  // sayılır (sayfa/sekme gezinmesi aynı aramayı ikinci kez saymaz). `after`:
  // yanıt gönderildikten sonra çalışır, aramayı yavaşlatmaz; core asla fırlatmaz.
  if (isNewSearch && page === 1 && requestedSort === "balanced") {
    const quality = {
      query,
      resultCount: resultTotal,
      usedFallback: isFallback,
      clarification: clarificationAsked || needsClarification,
      // Konuşma yolu da sözlükten derlenir: kademe 2.
      parserTier: parserTier ?? 2,
    };
    try {
      after(() => recordTextSearchQuality(db, quality));
    } catch {
      console.error("[ara] search quality skipped");
    }
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

  const totalPages = Math.ceil(resultTotal / PAGE_SIZE);

  return (
    <>
      <SearchWallGateClient show={shouldShowWall} />

      {outcome.mode === "results" ? (
        <p id="sonuc-sayisi" className={styles.count} role="status">
          {resultCountLabel(resultTotal)}
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

        {/* Sekmeler yalnizca gercek sonuclari siralar; yakin sonuclar alakaya gore dizilir. */}
        {outcome.mode === "results" ? <SortTabs tabs={tabs} /> : null}
      </div>

      {outcome.mode === "fallback" ? (
        <SearchFallbackResults items={items} />
      ) : outcome.mode === "empty" ? (
        <SearchNoResults />
      ) : (
        <ResultGrid items={items} />
      )}

      {outcome.mode === "results" && resultTotal > PAGE_SIZE ? (
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
          {page * PAGE_SIZE < resultTotal ? (
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
