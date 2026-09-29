import {
  BONUS_BALANCE_MAX,
  type EntitlementHistoryItem,
  getEntitlementStatus,
  getReferralSummary,
  listEntitlementHistory,
  REWARD_AMOUNTS,
  readAppUrl,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { nextResetLabel, searchRightsSummary } from "../ara/search-rights-copy.ts";
import styles from "./page.module.css";
import { ReferralLinkClient } from "./referral-link-client.tsx";

const OPERATION_LABEL = {
  visual_search: "Fotoğrafla arama",
  link_search: "Bağlantıyla arama",
} as const;

const STATE_LABEL = {
  reserved: "sürüyor",
  settled: "kullanıldı",
  refunded: "iade edildi",
} as const;

const BONUS_REASON_LABEL: Record<string, string> = {
  referral_inviter: "Davet ödülü",
  referral_invitee: "Davetle katılım ödülü",
  feedback_first: "İlk geri bildirim ödülü",
  admin_grant: "Hediye bonus hak",
  campaign: "Kampanya bonus hakkı",
};

const DATE_FORMAT = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

function historyLabel(item: EntitlementHistoryItem): string {
  if (item.kind === "bonus") {
    return `${BONUS_REASON_LABEL[item.reason] ?? "Bonus hak"} · +${item.delta}`;
  }
  const source = item.fromBonus > 0 ? " · bonus haktan" : "";
  return `${OPERATION_LABEL[item.operation]} · ${STATE_LABEL[item.state]}${source}`;
}

/**
 * `/hesap` "Arama hakların" (docs/decisions/0047): kalan gunluk ve bonus
 * hak, yenilenme zamani, davet linki ve son hareketler. Degerlerin hepsi
 * sunucuda hesaplanir; istemci yalnizca linki kopyalar.
 */
export async function SearchRightsSection({ userId }: { userId: number }) {
  const db = getDatabase();
  const [status, referral, history] = await Promise.all([
    getEntitlementStatus(db, userId),
    getReferralSummary(db, userId),
    listEntitlementHistory(db, userId, 10),
  ]);
  const invitePath = `/davet/${referral.code}`;
  const appUrl = readAppUrl();
  const inviteUrl = appUrl ? new URL(invitePath, appUrl).toString() : invitePath;

  return (
    <section className={styles.panel} aria-labelledby="arama-haklari">
      <div className={styles.panelHeader}>
        <h2 id="arama-haklari" className={styles.sectionTitle}>
          Arama hakların
        </h2>
        <p className={styles.sectionDescription}>
          Fotoğrafla ve bağlantıyla arama her seferinde bir arama hakkı kullanır. Metinle arama
          ücretsizdir. Önce günlük hakların, bitince bonus hakların kullanılır.
        </p>
      </div>

      <div className={styles.rightsStats}>
        <p className={styles.rightsValue}>{searchRightsSummary(status)}</p>
        <p className={styles.sectionDescription}>
          {nextResetLabel(status.nextResetAt)} Günlük haklar birikmez; bonus hakların sıfırlanmaz
          (en fazla {BONUS_BALANCE_MAX}).
        </p>
      </div>

      <div className={styles.rightsEarn}>
        <h3 className={styles.photoTitle}>Bonus hak kazan</h3>
        <p className={styles.sectionDescription}>
          Davet linkinle katılan biri ilk fotoğraf ya da bağlantı aramasını yaptığında sen{" "}
          {REWARD_AMOUNTS.referralInviter}, o {REWARD_AMOUNTS.referralInvitee} bonus hak kazanır.
        </p>
        <ReferralLinkClient url={inviteUrl} />
        <p className={styles.sectionDescription}>
          Davet ettiklerin: {referral.qualified} ödül kazandı, {referral.pending} ilk aramasını
          bekliyor.
        </p>
      </div>

      {history.length > 0 ? (
        <div className={styles.rightsEarn}>
          <h3 className={styles.photoTitle}>Son hareketler</h3>
          <ul className={styles.rightsHistory}>
            {history.map((item) => (
              <li key={`${item.kind}-${item.at.toISOString()}-${historyLabel(item)}`}>
                <span>{historyLabel(item)}</span>
                <time dateTime={item.at.toISOString()} className={styles.sectionDescription}>
                  {DATE_FORMAT.format(item.at)}
                </time>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
