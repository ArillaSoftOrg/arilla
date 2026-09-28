import { getConsents } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { Button } from "@arilla/ui";
import { cookies } from "next/headers";
import type { CSSProperties } from "react";
import { logoutAction } from "../cikis-actions.ts";
import { requireUser } from "../lib/dal.ts";
import { readThemeCookie } from "../lib/theme.ts";
import { ThemeToggleClient } from "../theme-toggle-client.tsx";
import { ClearHistoryButtonClient } from "./clear-history-button-client.tsx";
import { ConsentTogglesClient } from "./consent-toggles-client.tsx";
import { DeleteAccountButtonClient } from "./delete-account-button-client.tsx";
import styles from "./page.module.css";

/**
 * docs/pages.md "/hesap": Profil, Beden profili, Tema, İzinler, Verilerim.
 * Beden profili bu görevde yok - genel bir kategori/beden seçici arayüzü
 * gerektirir ve backlog.md E3'ün "Yap" satırında geçmiyor (rıza tercihleri,
 * veri indirme, geçmiş silme, hesap silme).
 */
export default async function HesapPage() {
  const user = await requireUser();
  const db = getDatabase();
  const [consents, theme] = await Promise.all([
    getConsents(db, user.id),
    (async () => readThemeCookie((await cookies()).get("theme")?.value))(),
  ]);
  const accountLabel = user.email ?? "E-posta bağlı değil";
  const displayLabel = user.displayName?.trim() || "ManiCepte kullanıcısı";
  const avatarLabel = (displayLabel.charAt(0) || accountLabel.charAt(0) || "M").toLocaleUpperCase(
    "tr-TR",
  );
  const avatarPhotoStyle = user.avatarUrl
    ? ({ backgroundImage: `url(${JSON.stringify(user.avatarUrl)})` } satisfies CSSProperties)
    : undefined;
  const themeLabel =
    theme === "dark"
      ? "Koyu tema açık."
      : theme === "light"
        ? "Açık tema açık."
        : "Cihaz teması takip ediliyor.";

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Hesabım</p>
          <h1 className={styles.title}>Ayarlarını tek yerden yönet.</h1>
          <p className={styles.lead}>
            Profilini, görünüm tercihini, izinlerini ve verilerini buradan düzenleyebilirsin.
          </p>
        </div>

        <div className={styles.profileSummary}>
          <span className={styles.avatar} aria-hidden="true">
            {user.avatarUrl ? (
              <span className={styles.avatarPhoto} style={avatarPhotoStyle} />
            ) : (
              avatarLabel
            )}
          </span>
          <div className={styles.profileCopy}>
            <span className={styles.profileLabel}>Oturum açan hesap</span>
            <span className={styles.profileName}>{displayLabel}</span>
            {/* 0025: telefonla ya da e-postasız Apple ile giren kullanıcıda e-posta yok. */}
            <span className={styles.profileValue}>{accountLabel}</span>
          </div>
        </div>
      </header>

      <div className={styles.contentGrid}>
        <div className={styles.mainColumn}>
          <section className={styles.panel} aria-labelledby="hesap-profil">
            <div className={styles.panelHeader}>
              <h2 id="hesap-profil" className={styles.sectionTitle}>
                Profil
              </h2>
              <p className={styles.sectionDescription}>
                Giriş bilgilerin ve oturum işlemlerin. Hesaptan çıkış yaptığında tekrar giriş
                bağlantısı veya doğrulama kodu gerekir.
              </p>
            </div>
            <div className={styles.photoBlock}>
              <span className={styles.photoPreview} aria-hidden="true">
                {user.avatarUrl ? (
                  <span className={styles.avatarPhoto} style={avatarPhotoStyle} />
                ) : (
                  avatarLabel
                )}
              </span>
              <div className={styles.photoCopy}>
                <p className={styles.photoTitle}>Profil fotoğrafı</p>
                <p className={styles.sectionDescription}>
                  Google ile giriş yaptıysan fotoğrafın otomatik görünür. Özel fotoğraf yükleme
                  yakında buraya eklenecek.
                </p>
              </div>
            </div>
            <div className={styles.profileActions}>
              {/* Düz form + server action: JavaScript olmadan da POST ile çalışır. */}
              <form action={logoutAction}>
                <Button type="submit" variant="secondary" shape="pill">
                  Çıkış yap
                </Button>
              </form>
            </div>
          </section>

          <section className={styles.panel} aria-labelledby="hesap-izinler">
            <div className={styles.panelHeader}>
              <h2 id="hesap-izinler" className={styles.sectionTitle}>
                İzinler
              </h2>
              <p className={styles.sectionDescription}>
                ManiCepte deneyimini kişiselleştirmek ve iletişim tercihlerini yönetmek için
                verdiğin izinleri buradan değiştirebilirsin.
              </p>
            </div>
            <ConsentTogglesClient
              historyAndPersonalization={consents.browsing_history || consents.personalization}
              marketingEmail={consents.marketing_email}
              publicDiscovery={consents.public_discovery}
            />
          </section>
        </div>

        <aside className={styles.sideColumn} aria-label="Hesap yardımcı ayarları">
          <section className={styles.panel} aria-labelledby="hesap-tema">
            <div className={styles.panelHeader}>
              <h2 id="hesap-tema" className={styles.sectionTitle}>
                Tema
              </h2>
              <p className={styles.sectionDescription}>
                Görünümü kullandığın ortama göre değiştir.
              </p>
            </div>
            <div className={styles.themeRow}>
              <p className={styles.themeState}>{themeLabel}</p>
              <ThemeToggleClient current={theme} />
            </div>
          </section>

          <section className={styles.panel} aria-labelledby="hesap-veriler">
            <div className={styles.panelHeader}>
              <h2 id="hesap-veriler" className={styles.sectionTitle}>
                Verilerim
              </h2>
              <p className={styles.sectionDescription}>
                Hesap verilerinin bir kopyasını JSON formatında indirebilirsin.
              </p>
            </div>
            <div className={styles.dataActions}>
              <a href="/hesap/veri-indir" className={styles.downloadLink}>
                Verilerimi indir
              </a>
            </div>
          </section>

          <section
            className={`${styles.panel} ${styles.dangerPanel}`}
            aria-labelledby="hesap-tehlikeli"
          >
            <div className={styles.panelHeader}>
              <h2 id="hesap-tehlikeli" className={styles.sectionTitle}>
                Veri ve hesap işlemleri
              </h2>
              <p className={styles.sectionDescription}>
                Geçmişini silebilir veya hesabını kapatabilirsin. Hesap silme işlemi geri alınamaz.
              </p>
            </div>
            <div className={styles.dangerActions}>
              <ClearHistoryButtonClient />
              <DeleteAccountButtonClient />
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
