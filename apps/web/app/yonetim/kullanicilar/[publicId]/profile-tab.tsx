import type { UserProfile } from "@arilla/core";
import type { ReactNode } from "react";
import styles from "../../admin.module.css";
import { KeyValues, Section, Tile } from "../../admin-ui.tsx";
import {
  chargeStateLabel,
  earlyAccessStatusLabel,
  formatCount,
  formatCounterSince,
  formatDateOrDash,
  formatDateTime,
  formatDelta,
  ledgerReasonLabel,
  referralStatusLabel,
  refundReasonLabel,
  roleLabel,
  searchOperationLabel,
  signupProviderLabel,
} from "../../format.ts";
import { RevealContactClient } from "../reveal-contact-client.tsx";

/** Arama hakkinin dolan penceresi (`quota/policy.ts`). */
const WINDOW_LABEL = { day: "Bugünkü", week: "Bu haftaki", month: "Bu ayki" } as const;

/**
 * Profil sekmesi (`users.read`). İletişim bilgisi maskelidir; tam değer
 * yalnızca `users.contact.reveal` yeteneği olanlara "Göster" düğmesiyle ve
 * taze girişle açılır (değer sayfa yüküne girmez). Sağlayıcı `subject`'i,
 * oturum token'ı, IP yok. Profil fotoğrafı adresi YÜKLENMEZ (üçüncü taraf
 * istek); yalnızca var/yok gösterilir.
 */
export function ProfileTab({ user, canReveal }: { user: UserProfile; canReveal: boolean }) {
  const contact = (field: "email" | "phone", masked: string): ReactNode =>
    canReveal ? (
      <RevealContactClient key={field} publicId={user.publicId} field={field} masked={masked} />
    ) : (
      masked
    );

  const account: [string, ReactNode][] = [
    ...(user.displayName ? ([["Ad", user.displayName]] as [string, ReactNode][]) : []),
    ["Rol", roleLabel(user.role)],
    ["E-posta", user.emailMasked ? contact("email", user.emailMasked) : "Yok"],
    ["E-posta doğrulandı", user.emailVerified ? "Evet" : "Hayır"],
    // Telefon bugün aktif bir giriş yolu değil; yalnızca kayıtlı bir değer varsa.
    ...(user.phoneMasked
      ? ([["Telefon", contact("phone", user.phoneMasked)]] as [string, ReactNode][])
      : []),
    ["Hesap kimliği", <code key="id">{user.publicId}</code>],
    ["Profil fotoğrafı", user.avatarUrl ? "Var (sağlayıcıdan; burada yüklenmez)" : "Yok"],
    ["Oluşturuldu", formatDateOrDash(user.createdAt)],
    ["Aktif oturum", formatCount(user.activeSessions)],
    ...(user.creatorHandle
      ? ([["Creator", `@${user.creatorHandle}`]] as [string, ReactNode][])
      : []),
  ];

  const { service } = user;
  const signIns: [string, ReactNode][] = [
    ["İlk giriş", formatDateTime(service.firstSignInAt)],
    [
      "Son giriş",
      service.lastSignInAt ? (
        <span key="last">
          {formatDateTime(service.lastSignInAt)}
          {service.lastSignInDerived ? <span className={styles.tag}>türetilmiş</span> : null}
        </span>
      ) : (
        "Bilinmiyor"
      ),
    ],
    ["Son aktif", service.lastActiveAt ? formatDateTime(service.lastActiveAt) : "Bilinmiyor"],
    ["Giriş sayısı", formatCounterSince(service.signInCount, service.serviceCountersSince)],
  ];

  const { status, chargeTotals, ledgerTotals, recentCharges, recentLedger } = user.entitlement;
  const settled = chargeTotals.find((row) => row.state === "settled");
  const refunded = chargeTotals.find((row) => row.state === "refunded");
  const reserved = chargeTotals.find((row) => row.state === "reserved");
  const bonusEarned = ledgerTotals
    .filter((row) => row.total > 0 && row.reason !== "search_refund")
    .reduce((sum, row) => sum + row.total, 0);

  return (
    <>
      <div className={styles.twoColumns}>
        <Section id="hesap" title="Hesap">
          <KeyValues items={account} />
        </Section>
        <div className={styles.page}>
          <Section id="girisler" title="Girişler">
            <KeyValues items={signIns} />
            {service.hasSummary ? null : (
              <p className={styles.meta}>
                Bu hesap için giriş özeti henüz yok (sayım başlamadan önce açılmış). Son giriş hesap
                kaydından türetildi; sayılar bilinmiyor.
              </p>
            )}
          </Section>
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
        <KeyValues
          items={[
            [
              "Bu saat (bonus aşamaz)",
              `${formatCount(status.windows.hour.remaining)} / ${formatCount(status.windows.hour.limit)}`,
            ],
            [
              "Bu hafta",
              `${formatCount(status.windows.week.remaining)} / ${formatCount(status.windows.week.limit)}`,
            ],
            [
              "Bu ay",
              `${formatCount(status.windows.month.remaining)} / ${formatCount(status.windows.month.limit)}`,
            ],
          ]}
        />
        {status.exhausted ? (
          <p className={styles.statusWarn}>
            {status.windows.hour.remaining === 0
              ? "Bu saatlik arama sınırı doldu."
              : `${WINDOW_LABEL[status.limitingWindow]} hakkı ve bonus bakiyesi kalmadı.`}
          </p>
        ) : null}
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
                    <td>{signupProviderLabel(identity.provider)}</td>
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
    </>
  );
}
