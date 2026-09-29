import { getUserDetail } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { KeyValues, PageHeader, Section } from "../../admin-ui.tsx";
import { formatCount, formatDateOrDash } from "../../format.ts";

const ROLE_LABELS: Record<string, string> = {
  user: "Kullanıcı",
  creator: "Creator",
  moderator: "Moderatör",
  admin: "Yönetici",
};

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
  phone: "Telefon",
};

const CONSENT_LABELS: Record<string, string> = {
  browsing_history: "Gezinme geçmişi",
  marketing_email: "Pazarlama e-postası",
  personalization: "Kişiselleştirme",
  public_discovery: "Keşfet'te görünme",
};

const MARKETING_SOURCE_LABELS: Record<string, string> = {
  signup: "Kayıt",
  early_access: "Erken erişim",
  account_settings: "Hesap ayarları",
  feedback: "Geri bildirim",
  admin_import: "Yönetim içe aktarımı",
  unsubscribe_link: "Abonelik iptal bağlantısı",
  iys: "İYS",
};

const SYNC_LABELS: Record<string, string> = {
  pending: "Bekliyor (İYS entegrasyonu yok)",
  synced: "Senkronlandı",
  failed: "Başarısız",
};

/**
 * Hesap ayrıntısı (Faz 6), salt okunur. Görüntüleme denetime yazılır.
 * İletişim bilgisi maskelidir; oturum token'ı, sağlayıcı kimliği, IP yok.
 */
export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { actor } = await requireCapability("users.read");
  const { publicId } = await params;
  const user = await getUserDetail(getDatabase(), actor, publicId);
  if (!user) notFound();

  return (
    <div className={styles.page}>
      <PageHeader title="Hesap">
        <p className={styles.muted}>
          <Link href="/yonetim/kullanicilar">Kullanıcılar</Link>
          {` / ${user.publicId}`}
        </p>
      </PageHeader>

      <div className={styles.twoColumns}>
        <Section id="hesap" title="Hesap">
          <KeyValues
            items={[
              ["Rol", ROLE_LABELS[user.role] ?? user.role],
              ["E-posta", user.emailMasked ?? "—"],
              ["E-posta doğrulandı", user.emailVerified ? "Evet" : "Hayır"],
              ["Telefon", user.phoneMasked ?? "—"],
              ["Oluşturuldu", formatDateOrDash(user.createdAt)],
              ["Son görülme", formatDateOrDash(user.lastSeenAt)],
              ["Aktif oturum", formatCount(user.activeSessions)],
              ["Creator", user.creatorHandle ? `@${user.creatorHandle}` : "—"],
            ]}
          />
        </Section>
        <Section id="kullanim" title="Kullanım">
          <KeyValues
            items={[
              ["Kaydedilen ürün", formatCount(user.savedItems)],
              ["Alarm (aktif / toplam)", `${user.alerts.active} / ${user.alerts.total}`],
            ]}
          />
        </Section>
      </div>

      <Section id="kimlikler" title="Giriş yöntemleri">
        {user.identities.length === 0 ? (
          <p className={styles.muted}>Yalnızca e-posta bağlantısıyla giriş.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Sağlayıcı</th>
                  <th scope="col">E-posta doğrulandı</th>
                  <th scope="col">Bağlandı</th>
                  <th scope="col">Son kullanım</th>
                </tr>
              </thead>
              <tbody>
                {user.identities.map((identity) => (
                  <tr key={`${identity.provider}-${identity.createdAt.toISOString()}`}>
                    <td>{PROVIDER_LABELS[identity.provider] ?? identity.provider}</td>
                    <td>{identity.emailVerified ? "Evet" : "Hayır"}</td>
                    <td>{formatDateOrDash(identity.createdAt)}</td>
                    <td>{formatDateOrDash(identity.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="rizalar" title="Rızalar (son durum)">
        {user.consents.length === 0 ? (
          <p className={styles.muted}>Kayıtlı rıza yok.</p>
        ) : (
          <KeyValues
            items={user.consents.map((consent) => [
              CONSENT_LABELS[consent.kind] ?? consent.kind,
              `${consent.granted ? "Verdi" : "Vermedi"} · ${formatDateOrDash(consent.at)}`,
            ])}
          />
        )}
      </Section>

      <Section id="pazarlama-e-postasi" title="Pazarlama e-postası">
        <KeyValues
          items={[
            ["Etkin durum", user.marketingEmail.optedIn ? "Gönderilebilir rıza var" : "Rıza yok"],
            [
              "Son olay",
              user.marketingEmail.latest
                ? `${user.marketingEmail.latest.granted ? "Verdi" : "Geri aldı"} · ${
                    user.marketingEmail.latest.source
                      ? (MARKETING_SOURCE_LABELS[user.marketingEmail.latest.source] ??
                        user.marketingEmail.latest.source)
                      : "Kaynak yok"
                  } · ${formatDateOrDash(user.marketingEmail.latest.at)}`
                : "—",
            ],
            [
              "Metin sürümü",
              user.marketingEmail.latest?.legacy
                ? "Sürümsüz (0033 öncesi, geçerli rıza sayılmaz)"
                : (user.marketingEmail.latest?.textVersion ?? "—"),
            ],
            [
              "Abonelik iptali",
              user.marketingEmail.lastSuppression
                ? formatDateOrDash(user.marketingEmail.lastSuppression.at)
                : "—",
            ],
            [
              "İYS senkronu",
              user.marketingEmail.externalSyncStatus
                ? (SYNC_LABELS[user.marketingEmail.externalSyncStatus] ??
                  user.marketingEmail.externalSyncStatus)
                : "—",
            ],
            ["Gönderilen pazarlama e-postası", formatCount(user.marketingEmail.sentCount)],
          ]}
        />
      </Section>

      <p className={styles.muted}>
        Rol değişikliği ve hesap silme bu ekranda yapılmaz. Hesap silme kullanıcının kendi isteğiyle
        /hesap üzerinden yürür.
      </p>
    </div>
  );
}
