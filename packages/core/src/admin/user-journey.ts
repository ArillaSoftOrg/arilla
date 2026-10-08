/**
 * `/yonetim/yolculuk` (karar 0085): kullanıcı yolculuğunun kimliksiz,
 * toplam görünümü.
 *
 * Veri temeli (ekranda her sayı bunu taşır):
 * - Tam sayım: kayıt/giriş (`auth_event`, hizmet kaydı), rıza kararları
 *   (`user_consent`, kişi başına SON karar), metin araması (`search_query_day`,
 *   kimliksiz), fiyat alarmı, davet ve bonus defteri toplamları.
 * - Rızalı örneklem: `user_activity_event` (yalnızca girişli + analitik
 *   rızalı kullanıcı, karar 0049). Kimliksiz görünür: hücrede
 *   `SMALL_CELL_MIN`'den az farklı kişi varsa sayılar gizlenir.
 *
 * Bilerek KULLANILMAYANLAR (events.md, 0049 §5):
 * - `click`: davranış analitiğine kaynak olmaz (attribution; /yonetim/affiliate).
 * - `product_view`: kullanıcının kendi gezinme geçmişi; rızası analitik değil.
 * Anonim ziyaret ve kimliksiz huni ölçülmüyor (Faz E telemetrisi).
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { SEARCH_QUALITY_TIME_ZONE } from "../search/quality.ts";
import { type AnalyticsWindow, parseAnalyticsWindow } from "./ai-operations.ts";
import { readOnly } from "./bounds.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

/** Örneklem hücresinde en az bu kadar farklı kişi yoksa sayı gösterilmez. */
export const SMALL_CELL_MIN = 5;

/** Oranı gösterilen rıza türleri (çerez bandı + hesap izinleri). */
export const JOURNEY_CONSENT_KINDS = [
  "cookie_analytics",
  "cookie_functional",
  "cookie_marketing",
  "browsing_history",
  "marketing_email",
  "personalization",
] as const;

export interface SampleCell {
  kind: string;
  /** Gizliyse `null` (küçük hücre). */
  events: number | null;
  users: number | null;
  suppressed: boolean;
}

export interface UserJourneyOverview {
  generatedAt: Date;
  days: AnalyticsWindow;
  totalUsers: number;
  signupsByDay: { day: string; signUps: number; signIns: number }[];
  signupsByProvider: { provider: string; count: number }[];
  consent: { kind: string; granted: number; denied: number }[];
  searchByDay: { day: string; searches: number; zeroResults: number; fallbacks: number }[];
  sample: SampleCell[];
  sampleUsers: number | null;
  alerts: { active: number; created: number; triggered: number; notified: number };
  referrals: { created: number; qualified: number; pending: number };
  bonus: { reason: string; entries: number; delta: number }[];
}

type Num = string | number | null;
const n = (value: Num | undefined): number => Number(value ?? 0);

/** Küçük hücre kuralı: farklı kişi sayısı eşiğin altındaysa iki sayı da gizlenir. */
export function suppressSmallCell(kind: string, events: number, users: number): SampleCell {
  if (users < SMALL_CELL_MIN) return { kind, events: null, users: null, suppressed: true };
  return { kind, events, users, suppressed: false };
}

export async function getUserJourneyOverview(
  db: Database,
  actor: AdminActor,
  options: { days?: unknown } = {},
  now: Date = new Date(),
): Promise<UserJourneyOverview> {
  assertCapability(actor, "analytics.read");
  const days = parseAnalyticsWindow(options.days, 30);
  const at = now.toISOString();
  const since = sql`(${at}::timestamptz - ${days}::int * interval '1 day')`;
  const sinceDay = sql`((${at}::timestamptz AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date - ${days - 1}::int)`;
  const dayOf = (column: ReturnType<typeof sql>) =>
    sql`to_char((${column} AT TIME ZONE ${SEARCH_QUALITY_TIME_ZONE})::date, 'YYYY-MM-DD')`;

  return readOnly(db, 8_000, async (tx) => {
    const users = await tx.execute<{ total: Num }>(sql`SELECT count(*) AS total FROM app_user`);
    // `auth_event_created_idx (created_at)`.
    const auth = await tx.execute<{ day: string; sign_ups: Num; sign_ins: Num }>(sql`
      SELECT ${dayOf(sql`created_at`)} AS day,
             count(*) FILTER (WHERE kind = 'sign_up') AS sign_ups,
             count(*) FILTER (WHERE kind = 'sign_in') AS sign_ins
        FROM auth_event
       WHERE created_at >= ${since} AND kind IN ('sign_up', 'sign_in')
       GROUP BY 1
       ORDER BY 1 DESC
    `);
    const providers = await tx.execute<{ provider: string | null; count: Num }>(sql`
      SELECT provider, count(*) AS count
        FROM auth_event
       WHERE created_at >= ${since} AND kind = 'sign_up'
       GROUP BY 1
       ORDER BY 2 DESC
    `);
    // Kişi başına SON karar (`user_consent_latest_idx`); geçmiş tablosu INSERT-only.
    const consent = await tx.execute<{ kind: string; granted: Num; denied: Num }>(sql`
      SELECT kind,
             count(*) FILTER (WHERE granted) AS granted,
             count(*) FILTER (WHERE NOT granted) AS denied
        FROM (
          SELECT DISTINCT ON (user_id, kind) kind, granted
            FROM user_consent
           WHERE kind IN (${sql.join(
             JOURNEY_CONSENT_KINDS.map((kind) => sql`${kind}`),
             sql`, `,
           )})
           ORDER BY user_id, kind, granted_at DESC, id DESC
        ) latest
       GROUP BY kind
    `);
    // Kimliksiz günlük özet; birincil anahtar (day, query_norm) ön eki.
    const search = await tx.execute<{ day: string; searches: Num; zero: Num; fallbacks: Num }>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(searches) AS searches,
             sum(zero_results) AS zero, sum(fallbacks) AS fallbacks
        FROM search_query_day
       WHERE day >= ${sinceDay}
       GROUP BY day
       ORDER BY day DESC
    `);
    // Rızalı örneklem (`user_activity_event_created_idx`). Kimlik dışarı çıkmaz.
    const sample = await tx.execute<{ kind: string; events: Num; users: Num }>(sql`
      SELECT kind, count(*) AS events, count(DISTINCT user_id) AS users
        FROM user_activity_event
       WHERE created_at >= ${since}
       GROUP BY kind
    `);
    const sampleUsers = await tx.execute<{ users: Num }>(sql`
      SELECT count(DISTINCT user_id) AS users FROM user_activity_event WHERE created_at >= ${since}
    `);
    const alerts = await tx.execute<{
      active: Num;
      created: Num;
      triggered: Num;
      notified: Num;
    }>(sql`
      SELECT count(*) FILTER (WHERE is_active) AS active,
             count(*) FILTER (WHERE created_at >= ${since}) AS created,
             count(*) FILTER (WHERE triggered_at >= ${since}) AS triggered,
             count(*) FILTER (WHERE notified_at >= ${since}) AS notified
        FROM alert
    `);
    const referrals = await tx.execute<{ created: Num; qualified: Num; pending: Num }>(sql`
      SELECT count(*) FILTER (WHERE created_at >= ${since}) AS created,
             count(*) FILTER (WHERE qualified_at >= ${since}) AS qualified,
             count(*) FILTER (WHERE status = 'pending') AS pending
        FROM referral
    `);
    const bonus = await tx.execute<{ reason: string; entries: Num; delta: Num }>(sql`
      SELECT reason, count(*) AS entries, COALESCE(sum(delta), 0) AS delta
        FROM bonus_ledger
       WHERE created_at >= ${since}
       GROUP BY reason
       ORDER BY 2 DESC
    `);

    const totalSampleUsers = n(sampleUsers.rows[0]?.users);
    const alertRow = alerts.rows[0];
    const referralRow = referrals.rows[0];
    return {
      generatedAt: now,
      days,
      totalUsers: n(users.rows[0]?.total),
      signupsByDay: auth.rows.map((row) => ({
        day: row.day,
        signUps: n(row.sign_ups),
        signIns: n(row.sign_ins),
      })),
      signupsByProvider: providers.rows.map((row) => ({
        provider: row.provider ?? "bilinmiyor",
        count: n(row.count),
      })),
      consent: JOURNEY_CONSENT_KINDS.map((kind) => {
        const row = consent.rows.find((r) => r.kind === kind);
        return { kind, granted: n(row?.granted), denied: n(row?.denied) };
      }),
      searchByDay: search.rows.map((row) => ({
        day: row.day,
        searches: n(row.searches),
        zeroResults: n(row.zero),
        fallbacks: n(row.fallbacks),
      })),
      sample: ["search_submitted", "product_viewed", "merchant_exit"].map((kind) => {
        const row = sample.rows.find((r) => r.kind === kind);
        return suppressSmallCell(kind, n(row?.events), n(row?.users));
      }),
      sampleUsers: totalSampleUsers < SMALL_CELL_MIN ? null : totalSampleUsers,
      alerts: {
        active: n(alertRow?.active),
        created: n(alertRow?.created),
        triggered: n(alertRow?.triggered),
        notified: n(alertRow?.notified),
      },
      referrals: {
        created: n(referralRow?.created),
        qualified: n(referralRow?.qualified),
        pending: n(referralRow?.pending),
      },
      bonus: bonus.rows.map((row) => ({
        reason: row.reason,
        entries: n(row.entries),
        delta: n(row.delta),
      })),
    };
  });
}
