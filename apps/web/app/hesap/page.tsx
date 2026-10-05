import { getReferralSummary, listHistory, REWARD_AMOUNTS, readAppUrl } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState, ProductCard, SearchIcon } from "@arilla/ui";
import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { requireUser } from "../lib/dal.ts";
import { ManageMenuClient } from "./manage-menu-client.tsx";
import styles from "./page.module.css";
import { ReferralLinkClient } from "./referral-link-client.tsx";

export const metadata: Metadata = {
  title: "Hesabım",
  robots: { index: false, follow: false },
};

/** Ürün aramasının gerçek giriş rotası (`apps/web/app/ara`): metin kutusu + fotoğraf/bağlantı eylemleri. */
const NEW_SEARCH_HREF = "/ara";
const RECENTS_LIMIT = 8;

/**
 * `/hesap` (karar 0060): sade profil sayfası. Profil kartı, davet bonusu ve
 * son gezilenler. Tema, izinler, veri indirme, geçmiş silme, arama hakkı
 * sayacı ve bülten tercihi bu sayfada YOKTUR; ilgili sunucu işlevleri yerinde
 * durur (veri indirme `/hesap/veri-indir`, geçmiş silme `/gecmis`).
 */
export default async function HesapPage() {
  const user = await requireUser();
  const db = getDatabase();
  const [referral, recents] = await Promise.all([
    getReferralSummary(db, user.id),
    listHistory(db, user.id, RECENTS_LIMIT),
  ]);

  const appUrl = readAppUrl();
  const invitePath = `/davet/${referral.code}`;
  const inviteUrl = appUrl ? new URL(invitePath, appUrl).toString() : invitePath;

  const accountLabel = user.email ?? "E-posta bağlı değil";
  const displayLabel = user.displayName?.trim() || "ManiCepte kullanıcısı";
  const avatarLabel = (displayLabel.charAt(0) || accountLabel.charAt(0) || "M").toLocaleUpperCase(
    "tr-TR",
  );
  const avatarPhotoStyle = user.avatarUrl
    ? ({ backgroundImage: `url(${JSON.stringify(user.avatarUrl)})` } satisfies CSSProperties)
    : undefined;

  return (
    <main className={styles.page}>
      <nav className={styles.breadcrumb} aria-label="Konum">
        <ol className={styles.breadcrumbList}>
          <li>
            <Link href="/" className={styles.breadcrumbLink}>
              Ana sayfa
            </Link>
          </li>
          <li aria-current="page">Hesabım</li>
        </ol>
      </nav>

      <header className={styles.profileCard}>
        <span className={styles.avatar} aria-hidden="true">
          {user.avatarUrl ? (
            <span className={styles.avatarPhoto} style={avatarPhotoStyle} />
          ) : (
            avatarLabel
          )}
        </span>
        <div className={styles.identity}>
          <h1 className={styles.name}>{displayLabel}</h1>
          {/* 0025: telefonla ya da e-postasız Apple ile giren kullanıcıda e-posta yok. */}
          <p className={styles.email}>{accountLabel}</p>
        </div>
        <div className={styles.profileActions}>
          <Link href={NEW_SEARCH_HREF} className={styles.newSearch} aria-label="Yeni arama">
            <SearchIcon size={18} />
            <span className={styles.newSearchLabel}>Yeni arama</span>
          </Link>
          <ManageMenuClient />
        </div>
      </header>

      <div className={styles.content}>
        <section className={styles.card} aria-labelledby="hesap-bonus">
          <h2 id="hesap-bonus" className={styles.cardTitle}>
            Bonus hak kazan
          </h2>
          <p className={styles.cardText}>
            Davet linkinle katılan biri ilk fotoğraf ya da bağlantı aramasını yaptığında sen{" "}
            {REWARD_AMOUNTS.referralInviter}, o {REWARD_AMOUNTS.referralInvitee} bonus hak kazanır.
          </p>
          <ReferralLinkClient url={inviteUrl} />
          <p className={styles.cardMeta}>
            Davet ettiklerin: {referral.qualified} ödül kazandı, {referral.pending} ilk aramasını
            bekliyor.
          </p>
        </section>

        <section className={styles.recents} aria-labelledby="hesap-son">
          <h2 id="hesap-son" className={styles.cardTitle}>
            Son baktıkların
          </h2>
          {recents.length === 0 ? (
            <EmptyState title="Henüz bakılan ürün yok." />
          ) : (
            <ul className={styles.recentList}>
              {recents.map((item) => (
                <li key={item.productId} className={styles.recentItem}>
                  <ProductCard
                    href={`/urun/${item.slug}`}
                    title={item.title}
                    imageUrl={item.primaryImageUrl}
                    minPrice={item.minPrice}
                    offerCount={item.offerCount}
                    offerCountLabel={(count) => `${count} mağaza`}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className={styles.footnote}>
        <Link href="/hesap/gizlilik" className={styles.breadcrumbLink}>
          Gizlilik tercihleri
        </Link>
      </p>
    </main>
  );
}
