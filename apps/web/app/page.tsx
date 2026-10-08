import {
  canAccessProduct,
  getDiscoverySlots,
  getPublicTrends,
  isChatDiscoveryEnabled,
  isChatImageEnabled,
  isProductOpen,
  type TrendSummary,
  todaySlotDate,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { DiscoveryGrid, HomeHero, Section, TrendCollectionCard } from "@arilla/ui";
import type { Metadata } from "next";
import { DEMO_HOMEPAGE_TRENDS } from "../data/demo/homepage-trends.ts";
import { findDemoProduct } from "../data/demo/products.ts";
import { COMING_SOON_COPY } from "./coming-soon-copy.ts";
import { ComingSoonLanding } from "./coming-soon-landing.tsx";
import { resolveDiscoveryItems } from "./discovery-adapter.ts";
import styles from "./home.module.css";
import { HOME_COPY } from "./home-copy.ts";
import { homeSectionLinks } from "./home-footer-groups.ts";
import { loadRecentProducts } from "./home-recent-products.ts";
import { HomeSearchComposer } from "./home-search-composer-client.tsx";
import { HomeSectionHeading } from "./home-section-heading.tsx";
import { type HomeWayCard, HomeWaysCarousel } from "./home-ways-carousel-client.tsx";
import { verifySession } from "./lib/dal.ts";
import { loadCachedEarlyAccessProgress } from "./lib/early-access-progress.ts";
import { PublicSiteShell } from "./public-site-shell.tsx";
import { SITE_BRAND } from "./site-config.ts";
import { startConversationAction } from "./sohbet/actions.ts";
import { TrendCardGrid } from "./trendler/trend-cards.tsx";
import { TREND_COPY } from "./trendler/trend-copy.ts";

/**
 * Kök metadata yalnızca ürün bayrağına bağlıdır, oturuma değil: arama
 * motoru ve paylaşım önizlemesi her zaman aynı başlığı görür. Ürün
 * kapalıyken (karar 0043) marka sayfası "yakında"dır; açılınca kök
 * layout'un varsayılanları kendiliğinden geri gelir.
 */
export function generateMetadata(): Metadata {
  if (isProductOpen()) {
    return { alternates: { canonical: "/" } };
  }
  return {
    title: COMING_SOON_COPY.metaTitle,
    description: COMING_SOON_COPY.metaDescription,
    alternates: { canonical: "/" },
    // openGraph iç içe birleşmez, yerine geçer: kökteki alanlar tekrar verilir.
    openGraph: {
      siteName: SITE_BRAND,
      locale: "tr_TR",
      type: "website",
      title: COMING_SOON_COPY.metaTitle,
      description: COMING_SOON_COPY.metaDescription,
      url: "/",
    },
  };
}

const HOME_WAYS: readonly HomeWayCard[] = [
  {
    id: "photo-search",
    title: "Fotoğrafla ara",
    mockLabel: "Fotoğraf yükle",
    mockImageUrl: "/ways/photo-search.png",
    tone: "aqua",
    mode: "image",
    ...pickWayProduct("ikea-markus-chair"),
  },
  {
    id: "paste-link",
    title: "Ürün linki yapıştır",
    mockLabel: "https://magaza.com/urun",
    mockImageUrl: "/ways/paste-link.png",
    tone: "mist",
    mode: "link",
    ...pickWayProduct("ikea-forsa-lamp"),
  },
  {
    id: "chat-refine",
    title: "Tarifle netleştir",
    mockLabel: "Daha sade, siyah, günlük",
    mockImageUrl: "/ways/chat-refine.png",
    tone: "warm",
    mode: "chat",
    ...pickWayProduct("nike-air-force-1-07"),
  },
  {
    id: "compare-offers",
    title: "Benzerlerini karşılaştır",
    mockLabel: "Aynı stile yakın seçenekler",
    mockImageUrl: "/ways/compare-offers.png",
    tone: "aqua",
    mode: "compare",
    ...pickWayProduct("carhartt-wip-detroit-jacket"),
  },
];

function pickWayProduct(id: string) {
  const product = findDemoProduct(id);
  return {
    imageUrl: product.imageUrl,
    imageAlt: product.imageAlt,
  };
}

/**
 * docs/pages.md "/". Tek is: arama baslatmak. Akis (kabuk icinde):
 * hero (h1 + deger onerisi) -> arama kutusu -> arama fikirleri chip'leri ->
 * Trendler (`#trendler`) -> kesif masonry'si (`#kesfet`) -> gorselli kullanim
 * yollari (`#nasil-calisir`). Header/footer, `<main>`, genis Container
 * ve yatay gutter `PublicSiteShell`'den gelir; bu sayfa yalnizca `Section`
 * dikey ritmini ve daha dar kolonlari (`--content-width-*`) kullanir.
 *
 * Veri:
 * - Trendler: gecici demo seti (`apps/web/data/demo/homepage-trends.ts`,
 *   SOURCES.md). Trend rotasi henuz yok - kartlar baglanti degil.
 * - Kesif: `getDiscoverySlots` (dar try/catch - bolum "bos durum: yok,
 *   sessizce atlanir" davranisini zaten destekliyor; `getDiscoverySlots`in
 *   kendisi degismez). Gercek veri > `HOMEPAGE_DEMO_CONTENT=true` demo >
 *   bos; bkz. discovery-adapter.ts. Ayni `DiscoveryGrid` `/kesfet`te.
 * - Nasil calisir: uzun aciklama yerine gorselli yatay kullanim kartlari.
 *
 * Performans: hero'da gorsel yok. Ilk trend kapagi LCP adayi (eager +
 * yuksek oncelik); diger tum trend/kesif gorselleri lazy + async decode,
 * yer `aspect-ratio` ile ayrilir (duzen kaymasi yok).
 */
async function loadDiscoveryItems(): Promise<Awaited<ReturnType<typeof getDiscoverySlots>>> {
  try {
    return await getDiscoverySlots(getDatabase(), todaySlotDate());
  } catch (error) {
    // Yalnizca hata sinifi/kodu - sorgu ayrintisi veya baglanti bilgisi loga
    // dusmez (CLAUDE.md: hata kayitlarinda kisisel veri yok).
    const code =
      error instanceof Error
        ? `${error.name}${"code" in error ? `:${String(error.code)}` : ""}`
        : "unknown";
    console.warn(
      `[anasayfa] discovery_slot sorgusu basarisiz, bos liste ile devam ediliyor (${code})`,
    );
    return [];
  }
}

/** Ana sayfada gosterilen trend sayisi (bir satir); fazlasi `/trendler`de. */
const HOME_TREND_COUNT = 3;

/**
 * Gercek `trend` kayitlari (karar 0077): once `featured`, sonra siraya gore ilk
 * uc. Hata/bos durumda bos liste: bolum gecici demo setine duser, sayfa bozulmaz.
 */
async function loadHomeTrends(): Promise<TrendSummary[]> {
  try {
    const trends = await getPublicTrends(getDatabase());
    const featured = trends.filter((trend) => trend.featured);
    const rest = trends.filter((trend) => !trend.featured);
    return [...featured, ...rest].slice(0, HOME_TREND_COUNT);
  } catch (error) {
    const code =
      error instanceof Error
        ? `${error.name}${"code" in error ? `:${String(error.code)}` : ""}`
        : "unknown";
    console.warn(`[anasayfa] trend sorgusu basarisiz, demo set ile devam ediliyor (${code})`);
    return [];
  }
}

export default async function HomePage() {
  const user = await verifySession();
  if (!canAccessProduct(user)) {
    // Lansman öncesi (karar 0043): yalnızca tanıtım. Keşif sorgusu, arama
    // kutusu ya da demo ürün görseli bu dala hiç girmez.
    return (
      <ComingSoonLanding
        signedIn={user !== null}
        progress={await loadCachedEarlyAccessProgress()}
      />
    );
  }

  const chatEnabled = isChatDiscoveryEnabled();
  const [items, recentProducts, homeTrends] = await Promise.all([
    loadDiscoveryItems(),
    loadRecentProducts(user?.id ?? null),
    loadHomeTrends(),
  ]);
  const discoveryItems = resolveDiscoveryItems(items);
  // Kesif bolumu bu sayfada varsa "Keşfet" oraya gider; yoksa /kesfet'e.
  const discoverHref = discoveryItems.length > 0 ? "#kesfet" : "/kesfet";

  return (
    <PublicSiteShell links={homeSectionLinks(discoverHref)}>
      <div className={styles.page}>
        <Section spacing="none" aria-labelledby="anasayfa-baslik" className={styles.hero}>
          <HomeHero
            titleId="anasayfa-baslik"
            titleLead={HOME_COPY.heroTitleLead}
            titleAccent={HOME_COPY.heroTitleAccent}
            subtitle={HOME_COPY.heroSubline}
          >
            <HomeSearchComposer
              startChat={chatEnabled && user ? startConversationAction : undefined}
              chatInNewTab={chatEnabled && user !== null}
              imageChat={chatEnabled && user !== null && isChatImageEnabled()}
              recentProducts={recentProducts}
            />
          </HomeHero>
        </Section>

        {homeTrends.length > 0 ? (
          <Section id="trendler" aria-labelledby="trendler-baslik" className={styles.anchored}>
            <HomeSectionHeading
              id="trendler-baslik"
              title={HOME_COPY.trendsTitle}
              description={HOME_COPY.trendsSubtitle}
            />
            <TrendCardGrid trends={homeTrends} eagerFirst labelledBy="trendler-baslik" />
            <p className={styles.trendsMore}>
              <a href="/trendler" className={styles.trendsMoreLink}>
                {TREND_COPY.homeAllLink}
              </a>
            </p>
          </Section>
        ) : DEMO_HOMEPAGE_TRENDS.length > 0 ? (
          <Section id="trendler" aria-labelledby="trendler-baslik" className={styles.anchored}>
            <HomeSectionHeading
              id="trendler-baslik"
              title={HOME_COPY.trendsTitle}
              description={HOME_COPY.trendsSubtitle}
            />
            {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur. */}
            <ul role="list" className={styles.trendGrid}>
              {DEMO_HOMEPAGE_TRENDS.map((collection, index) => (
                <li key={collection.id} className={styles.trendItem}>
                  <TrendCollectionCard
                    {...collection}
                    heroImageLoading={index === 0 ? "eager" : "lazy"}
                    heroImageFetchPriority={index === 0 ? "high" : undefined}
                  />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {discoveryItems.length > 0 ? (
          <Section id="kesfet" aria-labelledby="kesfet-baslik" className={styles.anchored}>
            <HomeSectionHeading
              id="kesfet-baslik"
              title={HOME_COPY.discoveryTitle}
              description={HOME_COPY.discoverySubtitle}
            />
            <DiscoveryGrid items={discoveryItems} labelledBy="kesfet-baslik" />
          </Section>
        ) : null}

        <Section
          id="nasil-calisir"
          aria-labelledby="nasil-calisir-baslik"
          className={`${styles.anchored} ${styles.waysSection}`}
        >
          <HomeWaysCarousel title="Arilla ile arama yolları" items={HOME_WAYS} />
        </Section>
      </div>
    </PublicSiteShell>
  );
}
