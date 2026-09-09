import { resolveQuery, type SortMode, search } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { ClarificationBar, ProductCard, SearchForm, SortTabs } from "@arilla/ui";

const SORT_MODES: readonly SortMode[] = ["balanced", "best_deal", "closest_match"];

function isSortMode(value: string | undefined): value is SortMode {
  return SORT_MODES.includes(value as SortMode);
}

const SEARCH_PLACEHOLDER = "Ürün adı yaz, link yapıştır veya fotoğraf yükle";

interface AramaSearchParams {
  q?: string;
  sort?: string;
  sayfa?: string;
}

/**
 * docs/pages.md "/ara": arama girdisi -> netleştirme çubuğu (varsa) ->
 * sonuç sayısı -> sekmeler -> sonuç ızgarası -> sayfalama. Görsel arama
 * (/ara/gorsel) ve giriş modali bu görevin kapsamı dışında (D4, E1/E2).
 */
export default async function AramaPage({
  searchParams,
}: {
  searchParams: Promise<AramaSearchParams>;
}) {
  const { q, sort: sortParam, sayfa } = await searchParams;
  const query = q?.trim() ?? "";

  if (!query) {
    return (
      <main style={{ padding: 24, display: "grid", gap: 16 }}>
        <SearchForm placeholder={SEARCH_PLACEHOLDER} submitLabel="Ara" />
        <p>Aramak için yukarıya bir şey yaz.</p>
      </main>
    );
  }

  const db = getDatabase();
  const { parsed, needsClarification, candidateCategories } = await resolveQuery(db, query);

  const requestedSort = isSortMode(sortParam) ? sortParam : "balanced";
  const hasAnchor = parsed.anchor !== null;
  // C1'in metin ayristiricisi her zaman anchor: null uretir (kapsami disinda);
  // C2'nin search()'u closest_match'i anchor'siz kabul etmez. Metin
  // aramasinda bu sekme bu yuzden her zaman devre disi.
  const effectiveSort: SortMode =
    requestedSort === "closest_match" && !hasAnchor ? "balanced" : requestedSort;

  const page = Math.max(1, Number.parseInt(sayfa ?? "1", 10) || 1);
  const result = await search(
    db,
    { ...parsed, sort: effectiveSort },
    { limit: 24, offset: (page - 1) * 24 },
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

  function sortHref(target: SortMode): string {
    return `/ara?${new URLSearchParams({ q: query, sort: target }).toString()}`;
  }

  const tabs = [
    {
      value: "balanced",
      label: "Bizim seçtiklerimiz",
      href: sortHref("balanced"),
      active: effectiveSort === "balanced",
    },
    {
      value: "best_deal",
      label: "En iyi fırsatlar",
      href: sortHref("best_deal"),
      active: effectiveSort === "best_deal",
    },
    {
      value: "closest_match",
      label: "En yakın eşleşmeler",
      href: sortHref("closest_match"),
      active: effectiveSort === "closest_match",
      disabled: !hasAnchor,
    },
  ];

  return (
    <main style={{ padding: 24, display: "grid", gap: 16 }}>
      <SearchForm defaultValue={query} placeholder={SEARCH_PLACEHOLDER} submitLabel="Ara" />

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

      {!isFallback ? <p>{result.total} sonuç</p> : null}

      <SortTabs tabs={tabs} />

      {isFallback ? (
        <div>
          <p>Bu aramada sonuç bulamadık. Filtreleri gevşetmeyi deneyebilirsin.</p>
          <p>Sana en yakın bulduklarımız</p>
        </div>
      ) : null}

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

      {!isFallback && result.total > 24 ? (
        <nav style={{ display: "flex", gap: 8 }}>
          {page > 1 ? (
            <a href={`/ara?q=${encodeURIComponent(query)}&sort=${effectiveSort}&sayfa=${page - 1}`}>
              Önceki
            </a>
          ) : null}
          {page * 24 < result.total ? (
            <a href={`/ara?q=${encodeURIComponent(query)}&sort=${effectiveSort}&sayfa=${page + 1}`}>
              Sonraki
            </a>
          ) : null}
        </nav>
      ) : null}
    </main>
  );
}
