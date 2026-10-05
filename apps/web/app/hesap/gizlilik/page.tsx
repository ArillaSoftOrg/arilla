import { getConsents } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "../../lib/dal.ts";
import styles from "./page.module.css";
import { PrivacyTogglesClient } from "./privacy-toggles-client.tsx";

export const metadata: Metadata = {
  title: "Gizlilik tercihleri",
  robots: { index: false, follow: false },
};

/**
 * Rızanın geri çekilebildiği yer (karar 0059, docs/kvkk.md). Yeni hesaplarda
 * kişiselleştirme ve anonim keşif katkısı varsayılan açık başlar; `/hesap`
 * sade kalsın diye anahtarlar burada, ayrı bir sayfadadır. Haftalık özet
 * burada değildir: e-postadaki "abonelikten çık" bağlantısıyla kapanır.
 */
export default async function GizlilikTercihleriPage() {
  const user = await requireUser();
  const consents = await getConsents(getDatabase(), user.id);

  return (
    <main className={styles.page}>
      <nav className={styles.breadcrumb} aria-label="Konum">
        <Link href="/hesap" className={styles.link}>
          Hesabım
        </Link>{" "}
        › Gizlilik tercihleri
      </nav>
      <h1 className={styles.title}>Gizlilik tercihleri</h1>
      <p className={styles.text}>
        Bu iki tercih yeni hesaplarda açık başlar. İstediğin zaman kapatabilirsin; kapatınca ilgili
        veri kullanımı durur.
      </p>
      <PrivacyTogglesClient
        historyAndPersonalization={consents.browsing_history || consents.personalization}
        publicDiscovery={consents.public_discovery}
      />
    </main>
  );
}
