import { randomInt } from "node:crypto";
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
import { loginPathWithNext } from "@arilla/core/auth-redirect";
import { getDatabase } from "@arilla/db";
import { Container, DiscoveryGrid, EmptyState, HomeHero, Section } from "@arilla/ui";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { COMING_SOON_COPY } from "./coming-soon-copy.ts";
import { ComingSoonLanding } from "./coming-soon-landing.tsx";
import { toDiscoveryItems } from "./discovery-adapter.ts";
import styles from "./home.module.css";
import {
  DEFAULT_HOME_CATEGORY,
  HERO_IMAGE_SIZES,
  heroSrcSet,
  homeCategoryOption,
  selectHomeCategoryImages,
} from "./home-category-config.ts";
import {
  type HomeSearchParams,
  homeConversationHref,
  homeMode,
  isPrivateHomeMode,
} from "./home-chat-mode.ts";
import transition from "./home-chat-transition.module.css";
import { HOME_COPY } from "./home-copy.ts";
import { homeSectionLinks } from "./home-footer-groups.ts";
import { loadRecentProducts } from "./home-recent-products.ts";
import { HomeSearchComposer } from "./home-search-composer-client.tsx";
import { HomeSectionHeading } from "./home-section-heading.tsx";
import { verifySession } from "./lib/dal.ts";
import { loadCachedEarlyAccessProgress } from "./lib/early-access-progress.ts";
import { type AramaSearchParams, SearchPage } from "./lib/search/search-page.tsx";
import { PublicSiteShell, SubpageShell } from "./public-site-shell.tsx";
import { SITE_BRAND } from "./site-config.ts";
import { startConversationAction } from "./sohbet/actions.ts";
import { ConversationView } from "./sohbet/conversation-view.tsx";
import { GuestChatView } from "./sohbet/guest-chat-view.tsx";
import { TrendCardGrid } from "./trendler/trend-cards.tsx";
import { TREND_COPY } from "./trendler/trend-copy.ts";

/**
 * Kök metadata yalnızca ürün bayrağına bağlıdır, oturuma değil: arama
 * motoru ve paylaşım önizlemesi her zaman aynı başlığı görür. Ürün
 * kapalıyken (karar 0043) marka sayfası "yakında"dır; açılınca kök
 * layout'un varsayılanları kendiliğinden geri gelir.
 */
export async function generateMetadata({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<HomeSearchParams>;
} = {}): Promise<Metadata> {
  if (isProductOpen()) {
    // Karar 0204: `/?s=` (özel konuşma) ve `/?q=` (arama turu) dizinlenmez; kanonik adres her zaman `/`.
    if (isPrivateHomeMode(homeMode(await searchParams, isChatDiscoveryEnabled()))) {
      return {
        title: "Sohbet",
        robots: { index: false, follow: false },
        alternates: { canonical: "/" },
      };
    }
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
 * ilk ekran (h1 + arama + forma bagli ornekler) -> varsa son bakilanlar -> Trendler (`#trendler`) ->
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
 * Performans: ilk trend kapagi eager + yuksek oncelik; diger tum trend/kesif gorselleri lazy + async decode,
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
 * uc. Hata/bos durumda bos liste: içerik hazır olana kadar bölüm çizilmez.
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

/**
 * Sayfadaki sunucu eylemlerinin (`runTurnAction`: model çağrısı, en çok 3 deneme x 15 sn + bekleme)
 * ve `startChatBootstrapAction`ın `after()` işinin zaman aşımı. Sohbet artık ana sayfada çalışır
 * (karar 0204); eski `/sohbet/*` rotasındaki ayar buraya taşındı.
 */
export const maxDuration = 60;

export default async function HomePage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<HomeSearchParams>;
} = {}) {
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
  const params = await searchParams;
  const mode = homeMode(params, chatEnabled);
  if (mode.kind === "not_found") notFound();
  if (mode.kind === "conversation") {
    // Konuşma özeldir: girişsiz ziyaretçi giriş sonrası aynı konuşmaya döner (`next` yalnız kendi yolumuz).
    if (!user) {
      redirect(
        loginPathWithNext(
          homeConversationHref(mode.conversationId, { sirala: mode.sirala, ac: mode.ac }),
        ),
      );
    }
    return (
      <SubpageShell chrome="chat">
        <div className={transition.enter}>
          <ConversationView
            userId={user.id}
            conversationId={mode.conversationId}
            sirala={mode.sirala}
            ac={mode.ac}
          />
        </div>
      </SubpageShell>
    );
  }
  if (mode.kind === "guest") {
    // Misafir sohbeti (eski `/sohbet/misafir`, karar 0204): aynı yüzeyde, `/?q=&g=1[&n=..]`.
    const rawQuery = Array.isArray(params.q) ? params.q[0] : params.q;
    const rawSteps = Array.isArray(params.n) ? params.n : params.n ? [params.n] : [];
    return (
      <SubpageShell chrome="chat">
        <div className={transition.enter}>
          <GuestChatView
            query={(rawQuery ?? "").trim().slice(0, 500)}
            encodedSteps={rawSteps}
            signedIn={user !== null}
          />
        </div>
      </SubpageShell>
    );
  }
  if (mode.kind === "search") {
    // Arama turu (eski `/sohbet?q=`, karar 0176): aynı SearchPage, ana sayfada.
    return (
      <SubpageShell chrome="chat">
        <div className={transition.enter}>
          {await SearchPage({ searchParams: Promise.resolve(params as AramaSearchParams) })}
        </div>
      </SubpageShell>
    );
  }
  const imageFeatureEnabled = chatEnabled && isChatImageEnabled();
  // Misafir ilk ekranda fotoğraf girişini görebilmeli; tıklama mevcut giriş
  // kapısına gider. Oturumlu kullanıcıda dosya seçici yalnızca sunucu özelliği
  // gerçekten açıksa etkinleşir.
  const imageEntryAvailable = user === null || imageFeatureEnabled;
  const imageChat = imageFeatureEnabled && user !== null;
  const imageConsent =
    imageChat && user !== null && (await hasChatImageConsent(getDatabase(), user.id));
  const [items, recentProducts, homeTrends] = await Promise.all([
    loadDiscoveryItems(),
    loadRecentProducts(user?.id ?? null),
    loadHomeTrends(),
  ]);
  const discoveryItems = toDiscoveryItems(items);
  const imageVariantSeed = randomInt(0, 0x1_0000_0000);
  const initialImages = selectHomeCategoryImages(
    homeCategoryOption(DEFAULT_HOME_CATEGORY),
    imageVariantSeed,
  );

  return (
    <PublicSiteShell
      links={homeSectionLinks("#kesfet")}
      footerClassName={styles.homeFooter}
      headerAppearance="mobileHeroOverlay"
      fullBleed
    >
      <link
        rel="preload"
        as="image"
        href={initialImages.mobile}
        media="(max-width: 639.98px)"
        fetchPriority="high"
      />
      <link
        rel="preload"
        as="image"
        href={initialImages.desktop}
        imageSrcSet={heroSrcSet(initialImages.desktop)}
        imageSizes={HERO_IMAGE_SIZES}
        media="(min-width: 640px)"
        fetchPriority="high"
      />
      <div className={styles.page}>
        <Section spacing="none" aria-labelledby="anasayfa-baslik" className={styles.hero}>
          <HomeSearchComposer
            startChat={chatEnabled ? startConversationAction : undefined}
            chatInNewTab={false}
            imageChat={imageChat}
            imageEntryAvailable={imageEntryAvailable}
            imageConsent={imageConsent}
            imageVariantSeed={imageVariantSeed}
            recentProducts={recentProducts}
            searchClassName={styles.searchScreen}
            beforeSearch={
              <HomeHero
                titleId="anasayfa-baslik"
                titleLead={HOME_COPY.heroTitleLead}
                titleAccent={HOME_COPY.heroTitleAccent}
              />
            }
          />
        </Section>

        {homeTrends.length > 0 ? (
          <Section id="trendler" aria-labelledby="trendler-baslik" className={styles.anchored}>
            <Container size="wide">
              <HomeSectionHeading
                id="trendler-baslik"
                title={HOME_COPY.trendsTitle}
                description={HOME_COPY.trendsSubtitle}
              />
              <div className={styles.trendsViewport}>
                <TrendCardGrid trends={homeTrends} eagerFirst labelledBy="trendler-baslik" />
              </div>
              <p className={styles.trendsMore}>
                <a href="/trendler" className={styles.trendsMoreLink}>
                  {TREND_COPY.homeAllLink}
                </a>
              </p>
            </Container>
          </Section>
        ) : null}

        <Section id="kesfet" aria-labelledby="kesfet-baslik" className={styles.anchored}>
          <Container size="wide">
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
          </Container>
        </Section>
      </div>
    </PublicSiteShell>
  );
}
