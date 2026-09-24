import { getDiscoverySlots, todaySlotDate } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import {
  DiscoveryGrid,
  HomeHero,
  HomeTrustSection,
  HowItWorksCard,
  Section,
  TrendCollectionCard,
} from "@arilla/ui";
import type { Metadata } from "next";
import { DEMO_HOMEPAGE_TRENDS } from "../data/demo/homepage-trends.ts";
import { resolveDiscoveryItems } from "./discovery-adapter.ts";
import styles from "./home.module.css";
import { HOME_COPY } from "./home-copy.ts";
import { homeSectionLinks } from "./home-footer-groups.ts";
import { HOME_HOW_IT_WORKS_STEPS } from "./home-how-it-works-steps.tsx";
import { HomeSearchComposer } from "./home-search-composer-client.tsx";
import { HomeSectionHeading } from "./home-section-heading.tsx";
import { HOME_TRUST_POINTS } from "./home-trust-points.ts";
import { PublicSiteShell } from "./public-site-shell.tsx";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/**
 * docs/pages.md "/". Tek is: arama baslatmak. Akis (kabuk icinde):
 * hero (h1 + deger onerisi) -> arama kutusu -> arama fikirleri chip'leri ->
 * Trendler (`#trendler`) -> kesif masonry'si (`#kesfet`) -> Nasil calisir
 * (`#nasil-calisir`) -> Seffaflik. Header/footer, `<main>`, genis Container
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
 * - Nasil calisir: baglanti aramasi arama kutusuna bagli degil, "Yakında"
 *   olarak isaretli - sahte CTA yok.
 * - Seffaflik: sosyal kanit/dogrulanmamis sayi yok.
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
    console.error(
      `[anasayfa] discovery_slot sorgusu basarisiz, bos liste ile devam ediliyor (${code})`,
    );
    return [];
  }
}

export default async function HomePage() {
  const items = await loadDiscoveryItems();
  const discoveryItems = resolveDiscoveryItems(items);
  // Kesif bolumu bu sayfada varsa "Keşfet" oraya gider; yoksa /kesfet'e.
  const discoverHref = discoveryItems.length > 0 ? "#kesfet" : "/kesfet";

  return (
    <PublicSiteShell links={homeSectionLinks(discoverHref)}>
      <div className={styles.page}>
        <Section spacing="none" aria-labelledby="anasayfa-baslik" className={styles.hero}>
          <HomeHero
            titleId="anasayfa-baslik"
            title={HOME_COPY.heroTitle}
            subtitle={HOME_COPY.heroSubtitle}
          >
            <HomeSearchComposer />
          </HomeHero>
        </Section>

        {DEMO_HOMEPAGE_TRENDS.length > 0 ? (
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
          className={styles.anchored}
        >
          <HomeSectionHeading
            id="nasil-calisir-baslik"
            title={HOME_COPY.howItWorksTitle}
            description={HOME_COPY.howItWorksSubtitle}
          />
          {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur. */}
          <ol role="list" className={styles.steps}>
            {HOME_HOW_IT_WORKS_STEPS.map((step) => (
              <li key={step.id}>
                <HowItWorksCard {...step} />
              </li>
            ))}
          </ol>
          <p className={styles.outcome}>{HOME_COPY.howItWorksOutcome}</p>
        </Section>

        <Section aria-labelledby="seffaflik-baslik">
          <HomeTrustSection
            headingId="seffaflik-baslik"
            title={HOME_COPY.trustTitle}
            points={HOME_TRUST_POINTS}
          />
        </Section>
      </div>
    </PublicSiteShell>
  );
}
