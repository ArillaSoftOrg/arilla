import { getDeals } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { Badge, EmptyState, formatTRY, ProductCard } from "@arilla/ui";
import type { Metadata } from "next";
import { HOME_COPY } from "../home-copy.ts";
import actions from "../public-actions.module.css";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Fırsatlar – Arilla",
  description: "Fiyatı düşen ürünler, düşüş tutarı ve yüzdesiyle.",
  alternates: { canonical: "/firsatlar" },
};

/** Metinler docs/copy.md `deals.*` - anahtarlar yorumda. */
const DEALS_COPY = {
  title: "Fırsatlar", // deals.title
  lead: "Fiyatı son günlerde düşen ürünler. Düşüş, ürünün son 90 gündeki olağan fiyatına göre hesaplanır.", // deals.lead
  listLabel: "Fiyatı düşen ürünler", // deals.list_label
  emptyTitle: "Şu an öne çıkan bir fırsat yok.", // deals.empty_title
  emptyBody:
    "Fiyatı gerçekten düşen ürünler her gün yeniden belirlenir. Bu arada aradığın ürünü arayabilir veya keşfedilen ürünlere göz atabilirsin.", // deals.empty_body
  emptySearchAction: "Ürün ara", // deals.empty_search_action
  savingsPercent: (percent: number) => `%${percent} daha uygun`, // deals.savings_percent
  savingsAmount: (amount: string) => `${amount} tasarruf`, // deals.savings_amount
} as const;

/**
 * docs/pages.md "/firsatlar": "Fiyatı düşen ürünler, günlük üretilir. Her
 * kartta düşüş tutarı ve yüzdesi. list_price_inflated işaretli ürünler bu
 * listeden düşürülür." (bkz. packages/core/src/discovery-feed/get-deals.ts)
 *
 * Bos listede fırsat veya indirim uydurulmaz; kullaniciya arama ve keşfet
 * yollari gosterilir.
 */
export default async function FirsatlarPage() {
  const deals = await getDeals(getDatabase());

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1 className={styles.title}>{DEALS_COPY.title}</h1>
        <p className={styles.lead}>{DEALS_COPY.lead}</p>
      </header>

      {deals.length === 0 ? (
        <EmptyState
          className={styles.emptyPanel}
          headingLevel={2}
          title={DEALS_COPY.emptyTitle}
          description={DEALS_COPY.emptyBody}
          action={
            <>
              <a href="/" className={actions.primary}>
                {DEALS_COPY.emptySearchAction}
              </a>
              <a href="/kesfet" className={actions.secondary}>
                {HOME_COPY.navDiscover}
              </a>
            </>
          }
        />
      ) : (
        // biome-ignore lint/a11y/noRedundantRoles: `list-style: none` Safari/VoiceOver'da liste rolunu dusurur.
        <ul role="list" aria-label={DEALS_COPY.listLabel} className={styles.grid}>
          {deals.map((deal) => (
            <li key={deal.productId} className={styles.item}>
              <ProductCard
                href={`/urun/${deal.slug}`}
                title={deal.title}
                imageUrl={deal.primaryImageUrl}
                minPrice={deal.currentPrice}
              />
              <p className={styles.savings}>
                <Badge>{DEALS_COPY.savingsPercent(deal.savingsPercent)}</Badge>
                <span className={styles.savingsAmount}>
                  {DEALS_COPY.savingsAmount(formatTRY(deal.savingsKurus))}
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
