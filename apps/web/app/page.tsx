import {
  canAccessProduct,
  getDiscoverySlots,
  getHomepageProducts,
  getPublicTrends,
  hasChatImageConsent,
  isChatDiscoveryEnabled,
  isChatImageEnabled,
  isProductOpen,
  type TrendSummary,
  todaySlotDate,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { DiscoveryGrid, EmptyState, HomeHero, Section } from "@arilla/ui";
import type { Metadata } from "next";
import Image from "next/image";
import { COMING_SOON_COPY } from "./coming-soon-copy.ts";
import { ComingSoonLanding } from "./coming-soon-landing.tsx";
import { toDiscoveryItems } from "./discovery-adapter.ts";
import styles from "./home.module.css";
import { HOME_COPY } from "./home-copy.ts";
import { homeSectionLinks } from "./home-footer-groups.ts";
import { loadRecentProducts } from "./home-recent-products.ts";
import { HomeSearchComposer } from "./home-search-composer-client.tsx";
import { HomeSectionHeading } from "./home-section-heading.tsx";
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

/**
 * docs/pages.md "/". Tek is: arama baslatmak. Akis (kabuk icinde):
 * ilk ekran (robot + h1 + arama) -> yardim seridi -> varsa son bakilanlar -> Trendler (`#trendler`) ->
 * kesif masonry'si (`#kesfet`).
 * Header/footer, `<main>`, genis Container
 * ve yatay gutter `PublicSiteShell`'den gelir; bu sayfa yalnizca `Section`
 * dikey ritmini ve daha dar kolonlari (`--content-width-*`) kullanir.
 *
 * Veri:
 * - Trendler: gercek koleksiyonlar `/trendler/[slug]`a gider. Veri yoksa
 *   ornek urunler yerine kisa bir bos durum gosterilir.
 * - Kesif: `getDiscoverySlots` (dar try/catch; veri bosken baslik ve kisa
 *   bos durum korunur). Gercek veri > `HOMEPAGE_DEMO_CONTENT=true` demo >
 *   bos; bkz. discovery-adapter.ts. Ayni `DiscoveryGrid` `/kesfet`te.
 * Performans: kucuk, sabit hero robotu eager yuklenir. Ilk trend kapagi eager +
 * yuksek oncelik; diger tum trend/kesif gorselleri lazy + async decode,
 * yer `aspect-ratio` ile ayrilir (duzen kaymasi yok).
 */
async function loadDiscoveryItems(): Promise<Parameters<typeof toDiscoveryItems>[0]> {
  try {
    const db = getDatabase();
    const day = todaySlotDate();
    const slots = await getDiscoverySlots(db, day);
    return slots.some((item) => item.primaryImageUrl !== null)
      ? slots
      : await getHomepageProducts(db, day);
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
 * uc. Hata/bos durumda bos liste: bolum acik bir bos durum gosterir.
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
    console.warn(`[anasayfa] trend sorgusu basarisiz, bos liste ile devam ediliyor (${code})`);
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
  const imageEntryAvailable = chatEnabled && isChatImageEnabled();
  const imageChat = imageEntryAvailable && user !== null;
  const imageConsent =
    imageChat && user !== null && (await hasChatImageConsent(getDatabase(), user.id));
  const [items, recentProducts, homeTrends] = await Promise.all([
    loadDiscoveryItems(),
    loadRecentProducts(user?.id ?? null),
    loadHomeTrends(),
  ]);
  const discoveryItems = toDiscoveryItems(items);

  return (
    <PublicSiteShell links={homeSectionLinks("#kesfet")} footerClassName={styles.homeFooter}>
      <div className={styles.page}>
        <Section spacing="none" aria-labelledby="anasayfa-baslik" className={styles.hero}>
          <HomeSearchComposer
            startChat={chatEnabled ? startConversationAction : undefined}
            chatInNewTab={chatEnabled && user !== null}
            imageChat={imageChat}
            imageEntryAvailable={imageEntryAvailable}
            imageConsent={imageConsent}
            recentProducts={recentProducts}
            searchClassName={styles.searchScreen}
            beforeSearch={
              <HomeHero
                titleId="anasayfa-baslik"
                titleLead={HOME_COPY.heroTitleLead}
                titleAccent={HOME_COPY.heroTitleAccent}
                illustration={
                  <Image
                    src="/mascot/guide/robot-welcome.png"
                    alt=""
                    width={104}
                    height={104}
                    sizes="(min-width: 1024px) 104px, 88px"
                    loading="eager"
                    className={styles.heroRobot}
                  />
                }
              />
            }
            afterSearch={
              <div className={styles.howRail}>
                <p className={styles.howPrompt}>{HOME_COPY.howItWorksPrompt}</p>
                <div className={styles.howGuide}>
                  <Image
                    src="/mascot/guide/robot-how-it-works-point-v1.png"
                    alt=""
                    width={56}
                    height={56}
                    sizes="56px"
                    className={styles.howRobot}
                  />
                  <span aria-hidden="true">→</span>
                  <span>{HOME_COPY.howItWorksAction}</span>
                  <span className={styles.howSoon}>{HOME_COPY.howItWorksStatus}</span>
                </div>
              </div>
            }
          />
        </Section>

        <Section id="trendler" aria-labelledby="trendler-baslik" className={styles.anchored}>
          <HomeSectionHeading
            id="trendler-baslik"
            title={HOME_COPY.trendsTitle}
            description={homeTrends.length > 0 ? HOME_COPY.trendsSubtitle : undefined}
          />
          {homeTrends.length > 0 ? (
            <>
              <div className={styles.trendsViewport}>
                <TrendCardGrid trends={homeTrends} eagerFirst labelledBy="trendler-baslik" />
              </div>
              <p className={styles.trendsMore}>
                <a href="/trendler" className={styles.trendsMoreLink}>
                  {TREND_COPY.homeAllLink}
                </a>
              </p>
            </>
          ) : (
            <EmptyState
              tone="compact"
              title={HOME_COPY.trendsEmptyTitle}
              description={HOME_COPY.trendsEmptyDescription}
              className={styles.homeEmpty}
            />
          )}
        </Section>

        <Section id="kesfet" aria-labelledby="kesfet-baslik" className={styles.anchored}>
          <HomeSectionHeading
            id="kesfet-baslik"
            title={HOME_COPY.discoveryTitle}
            description={HOME_COPY.discoverySubtitle}
          />
          {discoveryItems.length > 0 ? (
            <DiscoveryGrid items={discoveryItems} labelledBy="kesfet-baslik" />
          ) : (
            <EmptyState
              tone="compact"
              title={HOME_COPY.kesfetEmptyTitle}
              description={HOME_COPY.kesfetEmptyDescription}
              className={styles.homeEmpty}
            />
          )}
        </Section>
      </div>
    </PublicSiteShell>
  );
}
