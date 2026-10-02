import { getUserDetail, hasCapability } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { KeyValues, PageHeader, Section, Tile } from "../../admin-ui.tsx";
import {
  chargeStateLabel,
  consentKindLabel,
  earlyAccessStatusLabel,
  formatCount,
  formatDateOrDash,
  formatDateTime,
  formatDelta,
  ledgerReasonLabel,
  referralStatusLabel,
  refundReasonLabel,
  roleLabel,
  searchOperationLabel,
} from "../../format.ts";
import { RevokeSessionsClient } from "./revoke-sessions-client.tsx";

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
  phone: "Telefon",
};

/**
 * Hesap ayrıntısı (Faz 6), SALT OKUNUR. Görüntüleme denetime yazılır.
 * İletişim bilgisi maskelidir; oturum token'ı, sağlayıcı kimliği, IP yok.
 * Arama hakkı rakamları hak motorunun kendi okumasından gelir
 * (`getEntitlementStatus`); bu sayfa yeniden hesaplamaz. Değeri olmayan
 * satır (telefon, creator) gösterilmez.
 *
 * Tek değişiklik: "Tüm oturumları kapat" (karar 0050, taze giriş, denetimli).
 * Rol, hak, davet ve rıza burada düzenlenmez.
 */
export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { user: viewer, actor } = await requireCapability("users.read");
  const { publicId } = await params;
  const user = await getUserDetail(getDatabase(), actor, publicId);
  if (!user) notFound();

  const account: [string, ReactNode][] = [
    ...(user.displayName ? ([["Ad", user.displayName]] as [string, ReactNode][]) : []),
    ["Rol", roleLabel(user.role)],
    ["E-posta", user.emailMasked ?? "Yok"],
    ["E-posta doğrulandı", user.emailVerified ? "Evet" : "Hayır"],
    // Telefon bugün aktif bir giriş yolu değil; yalnızca kayıtlı bir değer varsa.
    ...(user.phoneMasked ? ([["Telefon", user.phoneMasked]] as [string, ReactNode][]) : []),
    ["Hesap kimliği", <code key="id">{user.publicId}</code>],
    ["Oluşturuldu", formatDateOrDash(user.createdAt)],
    ["Son görülme", formatDateOrDash(user.lastSeenAt)],
    ["Aktif oturum", formatCount(user.activeSessions)],
    ...(user.creatorHandle
      ? ([["Creator", `@${user.creatorHandle}`]] as [string, ReactNode][])
      : []),
  ];

  const { status, chargeTotals, ledgerTotals, recentCharges, recentLedger } = user.entitlement;
  const settled = chargeTotals.find((row) => row.state === "settled");
  const refunded = chargeTotals.find((row) => row.state === "refunded");
  const reserved = chargeTotals.find((row) => row.state === "reserved");
  const bonusEarned = ledgerTotals
    .filter((row) => row.total > 0 && row.reason !== "search_refund")
    .reduce((sum, row) => sum + row.total, 0);

  return (
    <div className={styles.page}>
      <PageHeader title={user.displayName ?? "Hesap"}>
        <p className={styles.muted}>
          <Link href="/yonetim/kullanicilar">Kullanıcılar</Link>
          {" / "}
          <span className={styles.mono}>{user.publicId}</span>
        </p>
      </PageHeader>

      <div className={styles.twoColumns}>
        <Section id="hesap" title="Hesap">
          <KeyValues items={account} />
          {hasCapability(viewer.role, "users.sessions.revoke") ? (
            <RevokeSessionsClient publicId={user.publicId} activeSessions={user.activeSessions} />
          ) : null}
        </Section>
        <div className={styles.page}>
          <Section id="kullanim" title="Kullanım">
            <KeyValues
              items={[
                ["Kaydedilen ürün", formatCount(user.savedItems)],
                ["Alarm (aktif / toplam)", `${user.alerts.active} / ${user.alerts.total}`],
              ]}
            />
          </Section>
          <Section id="erken-erisim" title="Erken erişim">
            {user.earlyAccess ? (
              <KeyValues
                items={[
                  ["Durum", earlyAccessStatusLabel(user.earlyAccess.status)],
                  ["Katıldı", formatDateTime(user.earlyAccess.joinedAt)],
                  ...(user.earlyAccess.updatedAt.getTime() !== user.earlyAccess.joinedAt.getTime()
                    ? ([["Son güncelleme", formatDateTime(user.earlyAccess.updatedAt)]] as [
                        string,
                        ReactNode,
                      ][])
                    : []),
                ]}
              />
            ) : (
              <p className={styles.muted}>
                Erken erişim listesinde değil (yönetim hesapları ve ürün açıkken giriş yapanlar
                listeye yazılmaz).
              </p>
            )}
          </Section>
        </div>
      </div>

      <Section id="arama-haklari" title="Arama hakları">
        <section className={styles.tiles} aria-label="Bugünkü hak durumu">
          <Tile
            label="Bugün kalan günlük hak"
            value={`${formatCount(status.dailyRemaining)} / ${formatCount(status.dailyLimit)}`}
            note={`Kullanılan: ${formatCount(status.dailyUsed)} · yenilenme ${formatDateTime(
              status.nextResetAt,
            )}`}
          />
          <Tile
            label="Bonus bakiyesi"
            value={formatCount(status.bonus)}
            note={
              bonusEarned > 0 ? `Toplam kazanılan bonus: ${formatCount(bonusEarned)}` : undefined
            }
          />
          <Tile
            label="Kullanılan arama"
            value={formatCount(settled?.count ?? 0)}
            note={`${formatCount(settled?.cost ?? 0)} hak harcandı`}
          />
          <Tile
            label="İade edilen arama"
            value={formatCount(refunded?.count ?? 0)}
            note={reserved?.count ? `${formatCount(reserved.count)} arama sürüyor` : undefined}
            warning={(reserved?.count ?? 0) > 0}
          />
        </section>
        {status.exhausted ? <p className={styles.statusWarn}>Bugün için hakkı kalmadı.</p> : null}
        {ledgerTotals.length > 0 ? (
          <KeyValues
            items={ledgerTotals.map((row) => [
              ledgerReasonLabel(row.reason),
              `${formatDelta(row.total)} (${formatCount(row.entries)} kayıt)`,
            ])}
          />
        ) : null}
      </Section>

      <Section id="davetler" title="Davetler">
        <KeyValues
          items={[
            [
              "Davet kodu",
              user.referral.code ? (
                <code key="code">{user.referral.code}</code>
              ) : (
                "Henüz oluşturulmadı"
              ),
            ],
            ["Geçerli davet", formatCount(user.referral.invitesQualified)],
            ["Bekleyen davet", formatCount(user.referral.invitesPending)],
            ["Davetten kazanılan bonus", formatCount(user.referral.rewardsEarned)],
            [
              "Davetle mi geldi",
              user.referral.invitedBy
                ? `Evet · ${referralStatusLabel(user.referral.invitedBy.status)} · ${formatDateTime(
                    user.referral.invitedBy.at,
                  )}`
                : "Hayır",
            ],
          ]}
        />
        <p className={styles.muted}>
          Davet edilen ve davet eden hesapların kimliği burada gösterilmez.
        </p>
      </Section>

      <Section id="hak-hareketleri" title="Son hak hareketleri">
        {recentCharges.length === 0 && recentLedger.length === 0 ? (
          <p className={styles.muted}>
            Hak hareketi yok: fotoğrafla ya da linkle arama yapmamış, bonus almamış.
          </p>
        ) : null}
        {recentCharges.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.meta}>Son pahalı aramalar</caption>
              <thead>
                <tr>
                  <th scope="col">Tarih</th>
                  <th scope="col">Tür</th>
                  <th scope="col">Durum</th>
                  <th scope="col" className={styles.num}>
                    Hak
                  </th>
                  <th scope="col">Kaynak</th>
                </tr>
              </thead>
              <tbody>
                {recentCharges.map((row) => (
                  <tr key={`${row.createdAt.toISOString()}-${row.operation}-${row.state}`}>
                    <td>{formatDateTime(row.createdAt)}</td>
                    <td>{searchOperationLabel(row.operation)}</td>
                    <td>
                      {chargeStateLabel(row.state)}
                      {row.refundReason ? ` · ${refundReasonLabel(row.refundReason)}` : ""}
                    </td>
                    <td className={styles.num}>{formatCount(row.cost)}</td>
                    <td>
                      {[
                        row.fromDaily > 0 ? `günlük ${formatCount(row.fromDaily)}` : null,
                        row.fromBonus > 0 ? `bonus ${formatCount(row.fromBonus)}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {recentLedger.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.meta}>Bonus defteri (son kayıtlar)</caption>
              <thead>
                <tr>
                  <th scope="col">Tarih</th>
                  <th scope="col">Hareket</th>
                  <th scope="col" className={styles.num}>
                    Değişim
                  </th>
                  <th scope="col" className={styles.num}>
                    Sonraki bakiye
                  </th>
                </tr>
              </thead>
              <tbody>
                {recentLedger.map((row) => (
                  <tr key={`${row.createdAt.toISOString()}-${row.reason}-${row.balanceAfter}`}>
                    <td>{formatDateTime(row.createdAt)}</td>
                    <td>{ledgerReasonLabel(row.reason)}</td>
                    <td className={styles.num}>{formatDelta(row.delta)}</td>
                    <td className={styles.num}>{formatCount(row.balanceAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>

      <Section id="kimlikler" title="Giriş yöntemleri">
        {user.identities.length === 0 ? (
          <p className={styles.muted}>Bağlı giriş sağlayıcısı yok (eski e-posta bağlantısı).</p>
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

      <Section id="rizalar" title="Rızalar">
        <KeyValues
          items={user.consents.map((consent) => [
            consentKindLabel(consent.kind),
            consent.latest
              ? `${consent.latest.granted ? "Verdi" : "Vermedi / geri çekti"} · ${formatDateOrDash(
                  consent.latest.at,
                )}`
              : "Kayıt yok",
          ])}
        />
      </Section>

      <p className={styles.muted}>
        Oturum kapatma dışında salt okunur ekran. Rol değişikliği yalnızca yerel betikle ya da
        onaylı SQL ile yapılır (docs/ops.md); hak, davet ve rıza burada düzenlenmez. Hesap silme
        kullanıcının kendi isteğiyle /hesap üzerinden yürür.
      </p>
    </div>
  );
}
