import { getDiscoverySlots, todaySlotDate } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import {
  DiscoveryCard,
  HomeHeader,
  HomeHero,
  HomeTrustSection,
  HowItWorksCard,
  SiteFooter,
  TrendCollectionCard,
} from "@arilla/ui";
import { DEMO_HOMEPAGE_TRENDS } from "../data/demo/homepage-trends.ts";
import { resolveDiscoveryItems } from "./discovery-adapter.ts";
import { HOME_COPY } from "./home-copy.ts";
import discoveryStyles from "./home-discovery.module.css";
import { HOME_FOOTER_GROUPS } from "./home-footer-groups.ts";
import { HOME_HOW_IT_WORKS_STEPS } from "./home-how-it-works-steps.tsx";
import { HomeSearchComposer } from "./home-search-composer-client.tsx";
import { HOME_TRUST_POINTS } from "./home-trust-points.ts";
import { verifySession } from "./lib/dal.ts";

/**
 * docs/pages.md "/" tablosu: logo + giris linki, arama girdisi, kisa
 * aciklama, kesfet izgarasi (E4), altbilgi. "Bos durum: yok. Kesfet
 * izgarasi her zaman doludur (curated havuz)" - discovery_slot hic
 * uretilmemisse (cron hic calismadiysa) bolum sessizce atlanir, bu tek
 * gercek bos durum.
 *
 * Faz 1: header + hero + arama kutusu `HomeHeader`/`HomeHero`/
 * `HomeSearchComposer` ile premium kabuga tasindi (karar 0025). Kesfet
 * izgarasi ve altbilgi bir sonraki faz - JSX'i aynen korunuyor.
 *
 * Faz 2: `#trendler` bolumu eklendi - header nav'indaki ayni id'li anchor'i
 * hedefler. Veri `apps/web/data/demo/homepage-trends.ts`ten (GECICI demo
 * seti, bkz. o dosyanin yanindaki SOURCES.md) geliyor; Admitad/feed
 * entegrasyonu gelince bu import bir DB sorgusuyla degisir, `TrendCollectionCard`
 * degismez.
 *
 * Faz 2.1: `getDiscoverySlots` cagrisi dar bir try/catch ile sarilir -
 * kesfet izgarasi "bos durum: yok, sessizce atlanir" davranisini zaten
 * destekliyor (docs/pages.md), bu yuzden sorgu hata verirse ayni bos-liste
 * yoluna dusmek guvenli. Bu SADECE bu non-critical, homepage'e ozgu
 * cagriyi kapsar - `getDiscoverySlots`in kendisi (paylasilan, `/kesfet`
 * tarafindan da kullaniliyor) DEGISMEZ, `verifySession()` veya baska hicbir
 * cagri bu catch'e dahil degil.
 *
 * Faz 3: `id="kesfet"` masonry bolumu eklendi. `discovery-adapter.ts`
 * gercek `discovery_slot` satirlarini `DiscoveryCard`'a cevirir. Ayni
 * `DiscoveryCard`/masonry hem gercek hem demo veriyi besler - iki ayri
 * UI yok.
 *
 * Faz 3.1: demo dusuşu `NODE_ENV` yerine explicit `HOMEPAGE_DEMO_CONTENT=true`
 * degiskenine bagli (bkz. .env.example) - satir yoksa VE bu deger acikca
 * "true" ise demo veri setine duser, aksi halde bos doner. Gercek veri
 * her zaman onceliklidir (bkz. resolveWithFallback, @arilla/core).
 *
 * Faz 4: `id="nasil-calisir"` eklendi - header nav'indaki anchor artik
 * gercek bir section'a gidiyor. Ucuncu adim (baglanti/URL ile arama) backend'de
 * var (kok catch-all `/[...link]`) ama arama kutusuna henuz baglanmadigi
 * icin `statusLabel` ile "Yakinda" olarak isaretlendi - sahte CTA yok
 * (bkz. home-how-it-works-steps.tsx).
 *
 * Faz 5: `HomeTrustSection` (sosyal kanit DEGIL, dogrulanmamis sayi yok) ve
 * gercek `SiteFooter` eklendi. Footer navigasyonu (home-footer-groups.ts)
 * YALNIZCA var olan route'lari icerir. Faz 6 ile /gizlilik, /kosullar,
 * /cerez (taslak) eklendi ve footer'a baglandi; /iletisim, /hakkinda hala yok
 * (dogrulanabilir iletisim bilgisi repoda yok), footer'da link YOK. Affiliate/fiyat-stok metinleri (`legal.*`, home-copy.ts) artik
 * tek yerde (SiteFooter disclosure bandi) - eskiden ayri, hardcoded footer
 * paragraflariydi.
 */
async function loadDiscoveryItems(): Promise<Awaited<ReturnType<typeof getDiscoverySlots>>> {
  try {
    return await getDiscoverySlots(getDatabase(), todaySlotDate());
  } catch (error) {
    console.error(
      "[anasayfa] discovery_slot sorgusu basarisiz, bos liste ile devam ediliyor:",
      error,
    );
    return [];
  }
}

export default async function HomePage() {
  const [items, user] = await Promise.all([loadDiscoveryItems(), verifySession()]);
  const discoveryItems = resolveDiscoveryItems(items);

  return (
    <>
      <HomeHeader
        brandLabel="Arilla"
        navItems={[
          // Trendler ve Nasil Calisir ayni sayfa ici anchor - ikisi de
          // gercek section'lara gider (id="trendler", id="nasil-calisir").
          { label: HOME_COPY.navTrends, href: "#trendler" },
          { label: HOME_COPY.navDiscover, href: "/kesfet" },
          { label: HOME_COPY.navHowItWorks, href: "#nasil-calisir" },
        ]}
        navAriaLabel="Ana gezinme"
        accountHref={user ? "/hesap" : null}
        accountLabel={HOME_COPY.navAccount}
        loginHref="/giris"
        loginLabel={HOME_COPY.loginLabel}
      />

      <main
        style={{
          display: "grid",
          gap: "var(--space-8)",
          paddingBlock: "var(--space-8) var(--space-6)",
          paddingInline: "var(--space-6)",
          maxWidth: "var(--content-width-wide)",
          marginInline: "auto",
          width: "100%",
        }}
      >
        <div
          style={{
            display: "grid",
            gap: "var(--space-6)",
            maxWidth: "var(--content-width-reading)",
            marginInline: "auto",
            width: "100%",
          }}
        >
          <HomeHero title={HOME_COPY.heroTitle} subtitle={HOME_COPY.heroSubtitle} />
          <HomeSearchComposer />
        </div>

        {DEMO_HOMEPAGE_TRENDS.length > 0 ? (
          <section
            id="trendler"
            aria-labelledby="trendler-heading"
            style={{ display: "grid", gap: "var(--space-6)" }}
          >
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              <h2
                id="trendler-heading"
                style={{
                  margin: 0,
                  fontSize: "var(--font-size-lg)",
                  fontWeight: 500,
                  color: "var(--ink)",
                }}
              >
                {HOME_COPY.trendsTitle}
              </h2>
              <p style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--ink-muted)" }}>
                {HOME_COPY.trendsSubtitle}
              </p>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: "var(--space-6)",
              }}
            >
              {DEMO_HOMEPAGE_TRENDS.map((collection) => (
                <TrendCollectionCard key={collection.id} {...collection} />
              ))}
            </div>
          </section>
        ) : null}

        {discoveryItems.length > 0 ? (
          <section
            id="kesfet"
            aria-labelledby="discovery-heading"
            style={{ display: "grid", gap: "var(--space-6)" }}
          >
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              <h2
                id="discovery-heading"
                style={{
                  margin: 0,
                  fontSize: "var(--font-size-lg)",
                  fontWeight: 500,
                  color: "var(--ink)",
                }}
              >
                {HOME_COPY.discoveryTitle}
              </h2>
              <p style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--ink-muted)" }}>
                {HOME_COPY.discoverySubtitle}
              </p>
            </div>
            <div className={discoveryStyles.masonry}>
              {discoveryItems.map((item) => (
                <DiscoveryCard key={item.id} {...item} />
              ))}
            </div>
          </section>
        ) : null}

        <section
          id="nasil-calisir"
          aria-labelledby="how-it-works-heading"
          style={{
            display: "grid",
            gap: "var(--space-6)",
            background: "var(--surface)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-8) var(--space-6)",
          }}
        >
          <div style={{ display: "grid", gap: "var(--space-2)", textAlign: "center" }}>
            <h2
              id="how-it-works-heading"
              style={{
                margin: 0,
                fontSize: "var(--font-size-lg)",
                fontWeight: 500,
                color: "var(--ink)",
              }}
            >
              {HOME_COPY.howItWorksTitle}
            </h2>
            <p
              style={{
                margin: "0 auto",
                maxWidth: "52ch",
                fontSize: "var(--font-size-sm)",
                color: "var(--ink-muted)",
              }}
            >
              {HOME_COPY.howItWorksSubtitle}
            </p>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: "var(--space-6)",
            }}
          >
            {HOME_HOW_IT_WORKS_STEPS.map((step) => (
              <HowItWorksCard key={step.id} {...step} />
            ))}
          </div>
          <p
            style={{
              margin: "0 auto",
              maxWidth: "60ch",
              textAlign: "center",
              fontSize: "var(--font-size-sm)",
              color: "var(--ink-muted)",
            }}
          >
            {HOME_COPY.howItWorksOutcome}
          </p>
        </section>

        <section aria-labelledby="trust-heading">
          <HomeTrustSection title={HOME_COPY.trustTitle} points={HOME_TRUST_POINTS} />
        </section>
      </main>

      <SiteFooter
        brandLabel="Arilla"
        brandDescription={HOME_COPY.heroSubtitle}
        groups={HOME_FOOTER_GROUPS}
        affiliateNotice={HOME_COPY.affiliateNotice}
        priceDisclaimer={HOME_COPY.priceDisclaimer}
        copyrightLabel={`© ${new Date().getFullYear()} Arilla`}
      />
    </>
  );
}
