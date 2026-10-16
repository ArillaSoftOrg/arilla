import {
  type FeedOfferCard,
  type FeedOfferKind,
  formatMinorWithCurrency,
  listFeedOffers,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState, formatTRY, ProductCard } from "@arilla/ui";
import type { Metadata } from "next";
import { requireProductAccess } from "../lib/dal.ts";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Mağaza ve yurt dışı teklifleri – Arilla",
  description: "Henüz bir ürünle eşleşmemiş mağaza teklifleri ve yurt dışı teklifleri.",
  alternates: { canonical: "/teklifler" },
  // Eşleşmemiş teklif listesi ince içeriktir; arama motoruna açılmaz.
  robots: { index: false, follow: false },
};

/** Metinler: docs/copy.md `offers.*` (karar 0114). */
const OFFERS_COPY = {
  title: "Mağaza teklifleri",
  lead: "Henüz bir ürün sayfasıyla eşleşmemiş teklifler. Her teklif mağazanın kendi sayfasına gider.",
  tabDomestic: "Türkiye'deki mağazalar",
  tabInternational: "Yurt dışı teklifleri",
  internationalNote:
    "Yurt dışı tekliflerinde fiyat mağazanın para birimiyle verilir. TL tutarı yaklaşıktır ve TCMB kuruyla hesaplanır. Kargo, gümrük ve vergi bilinmediği için toplam tutar farklı olabilir; bu teklifler fiyat sıralamasına girmez.",
  searchLabel: "Teklif ara",
  searchPlaceholder: "Ürün adı",
  sortLabel: "Sıralama",
  sortRecent: "En yeni",
  sortPrice: "En uygun fiyat",
  submit: "Göster",
  approx: (tl: string) => `≈ ${tl}`,
  rateNote: (date: string) => `TCMB kuru, ${date}`,
  noRate: "Kur bilgisi yok; TL tutarı gösterilmiyor.",
  shippingUnknown: "Kargo ve vergi belirsiz",
  sourceInternational: "Yurt dışı",
  emptyTitle: "Bu aramaya uyan teklif yok.",
  emptyBody: "Farklı bir kelimeyle aramayı dene ya da diğer sekmeye bak.",
  timedOutTitle: "Arama tamamlanamadı.",
  timedOutBody: "Daha belirgin kelimelerle tekrar dene.",
  next: "Sonraki sayfa",
  prev: "Önceki sayfa",
} as const;

function trDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function href(params: { tur: FeedOfferKind; q?: string | null; sirala?: string; sayfa?: number }) {
  const search = new URLSearchParams();
  search.set("tur", params.tur === "international" ? "yurt-disi" : "yurt-ici");
  if (params.q) search.set("q", params.q);
  if (params.sirala === "fiyat") search.set("sirala", "fiyat");
  if (params.sayfa && params.sayfa > 1) search.set("sayfa", String(params.sayfa));
  return `/teklifler?${search.toString()}`;
}

function OfferItem({ offer }: { offer: FeedOfferCard }) {
  const international = offer.currency !== "TRY";
  const original = formatMinorWithCurrency(offer.priceMinor, offer.currency);
  return (
    <li className={styles.item}>
      <ProductCard
        href={`/git/${offer.offerId}?surface=feed_offers`}
        external
        title={offer.title}
        imageUrl={offer.imageUrl}
        // Yurt dışı: TL kuruşu `minPrice`'a VERİLMEZ (kesin fiyat gibi görünmesin).
        minPrice={international ? null : offer.priceMinor}
        priceLabel={
          international
            ? offer.approx
              ? `${OFFERS_COPY.approx(formatTRY(offer.approx.approxTryMinor))} · ${original}`
              : original
            : undefined
        }
        sourceLabel={international ? OFFERS_COPY.sourceInternational : undefined}
      />
      <p className={styles.meta}>{offer.merchantName}</p>
      {international ? (
        <p className={styles.meta}>
          {offer.approx
            ? OFFERS_COPY.rateNote(trDate(offer.approx.quote.effectiveDate))
            : OFFERS_COPY.noRate}
          {" · "}
          {OFFERS_COPY.shippingUnknown}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Kanonik ürüne bağlanmamış gerçek besleme teklifleri (karar 0114). Ürün
 * birleştirmesi yapılmaz. Yurt dışı teklifleri orijinal para birimiyle,
 * kur varsa yaklaşık TL ile gösterilir ve fiyat sıralamasına girmez.
 */
export default async function OffersPage({
  searchParams,
}: {
  searchParams: Promise<{ tur?: string; q?: string; sirala?: string; sayfa?: string }>;
}) {
  await requireProductAccess();
  const params = await searchParams;
  const kind: FeedOfferKind = params.tur === "yurt-disi" ? "international" : "domestic";
  const pageNumber = Number.parseInt(params.sayfa ?? "1", 10);
  const result = await listFeedOffers(getDatabase(), {
    kind,
    q: params.q ?? null,
    sort: params.sirala === "fiyat" ? "price" : "recent",
    page: Number.isFinite(pageNumber) ? pageNumber : 1,
  });
  const q = (params.q ?? "").slice(0, 100);
  const sortParam = result.sort === "price" ? "fiyat" : undefined;

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1 className={styles.title}>{OFFERS_COPY.title}</h1>
        <p className={styles.lead}>{OFFERS_COPY.lead}</p>
      </header>

      <nav aria-label={OFFERS_COPY.title}>
        {/* biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur. */}
        <ul role="list" className={styles.tabs}>
          {(["domestic", "international"] as const).map((tab) => (
            <li key={tab}>
              <a
                href={href({ tur: tab, q })}
                className={tab === kind ? styles.tabActive : styles.tab}
                aria-current={tab === kind ? "page" : undefined}
              >
                {tab === "international" ? OFFERS_COPY.tabInternational : OFFERS_COPY.tabDomestic}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {kind === "international" ? (
        <p className={styles.note}>{OFFERS_COPY.internationalNote}</p>
      ) : null}

      <form action="/teklifler" method="get" className={styles.filters}>
        <input
          type="hidden"
          name="tur"
          value={kind === "international" ? "yurt-disi" : "yurt-ici"}
        />
        <label className={styles.field}>
          {OFFERS_COPY.searchLabel}
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={OFFERS_COPY.searchPlaceholder}
            maxLength={100}
          />
        </label>
        {kind === "domestic" ? (
          <label className={styles.field}>
            {OFFERS_COPY.sortLabel}
            <select name="sirala" defaultValue={sortParam ?? ""}>
              <option value="">{OFFERS_COPY.sortRecent}</option>
              <option value="fiyat">{OFFERS_COPY.sortPrice}</option>
            </select>
          </label>
        ) : null}
        <button type="submit">{OFFERS_COPY.submit}</button>
      </form>

      {result.items.length === 0 ? (
        <EmptyState
          className={styles.emptyPanel}
          headingLevel={2}
          title={result.timedOut ? OFFERS_COPY.timedOutTitle : OFFERS_COPY.emptyTitle}
          description={result.timedOut ? OFFERS_COPY.timedOutBody : OFFERS_COPY.emptyBody}
        />
      ) : (
        // biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur.
        <ul role="list" aria-label={OFFERS_COPY.title} className={styles.grid}>
          {result.items.map((offer) => (
            <OfferItem key={offer.offerId} offer={offer} />
          ))}
        </ul>
      )}

      <nav className={styles.pager} aria-label={OFFERS_COPY.title}>
        {result.page > 1 ? (
          <a href={href({ tur: kind, q, sirala: sortParam, sayfa: result.page - 1 })}>
            {OFFERS_COPY.prev}
          </a>
        ) : null}
        {result.hasMore ? (
          <a href={href({ tur: kind, q, sirala: sortParam, sayfa: result.page + 1 })}>
            {OFFERS_COPY.next}
          </a>
        ) : null}
      </nav>
    </div>
  );
}
