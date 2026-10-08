/**
 * Pahali aramanin hak yasam dongusu (docs/decisions/0047 madde 5-8):
 *
 *   reserveSearch  -> saglayici/kuyruk -> settleCharge | refundCharge
 *
 * `reserveSearch` tek islemde calisir. Kilit sirasi HER ZAMAN ayni:
 * `ai_quota_day` satiri, sonra `bonus_account` satiri. Ayni kullanicinin
 * esanli istekleri bu kilitlerde siraya girer; READ COMMITTED'da kilidi
 * alan ifadeden sonraki her ifade yeni anlik goruntu okudugu icin, kilitten
 * sonra yapilan "ayni anahtar var mi / aktif arama var mi" kontrolleri
 * guvenilirdir. UNIQUE kisitlar (`ai_search_charge_request_key_unique`,
 * `ai_search_charge_one_active`) ve CHECK'ler son savunma hattidir.
 *
 * `settleCharge` ve `refundCharge` durum gecisini kosullu UPDATE ile yapar
 * (`WHERE state = 'reserved'`): donen satir yoksa gecis baska bir cagrida
 * zaten yapilmistir ve hicbir sey degismez. Iade gunluk hakki ayirmanin
 * yapildigi gune (`charge.day`) geri yazar, bugune degil.
 */
import type { AiSearchChargeState, AiSearchOperation, Database } from "@arilla/db";
import { type SQL, sql } from "drizzle-orm";
import type { QuotaWindow } from "../quota/policy.ts";
import { lockBonusAccount } from "./bonus.ts";
import { AI_OPERATION_COST, dailySearchLimit, SEARCH_RIGHTS_LIMITS } from "./config.ts";
import { rows, type Tx, uniqueViolationConstraint } from "./db.ts";
import { qualifyReferralInTx } from "./referral.ts";
import { splitCharge } from "./split.ts";

const REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export class InvalidRequestKeyError extends Error {
  constructor() {
    super("gecersiz istek anahtari");
    this.name = "InvalidRequestKeyError";
  }
}

export function isValidRequestKey(value: unknown): value is string {
  return typeof value === "string" && REQUEST_KEY_PATTERN.test(value);
}

/** Islem ani; `now` verilmezse veritabaninin saati. */
function atSql(now: Date | undefined): SQL {
  return now ? sql`(${now.toISOString()}::timestamptz)` : sql`now()`;
}

/** Istanbul takvim gunu; `now` verilmezse veritabaninin saati. */
function istanbulDaySql(now: Date | undefined) {
  return sql`((${atSql(now)}) AT TIME ZONE 'Europe/Istanbul')::date`;
}

/** Istanbul takvim saatinin/haftasinin (pazartesi)/ayinin baslangici, timestamptz. */
function periodStartSql(unit: "hour" | "week" | "month", at: SQL): SQL {
  return sql`(date_trunc(${sql.raw(`'${unit}'`)}, (${at}) AT TIME ZONE 'Europe/Istanbul') AT TIME ZONE 'Europe/Istanbul')`;
}

export interface PeriodUsage {
  /** Bu saatte harcanan TUM hak (donem + bonus): patlama siniri. */
  hour: number;
  /** Bu hafta/ay donem hakkindan harcanan (bonus haric; gunluk `used` ile ayni olcu). */
  week: number;
  month: number;
}

/**
 * Saat/hafta/ay kullanimi `ai_search_charge`'tan (iade edilenler haric). Gun
 * `ai_quota_day.used`'tadir. Kilitlerden SONRA okunur: ayni kullanicinin
 * ayirmalari `ai_quota_day` satir kilidi ve tek-aktif-arama indeksiyle sirali.
 */
export async function readPeriodUsage(
  db: Database | Tx,
  userId: number,
  now?: Date,
): Promise<PeriodUsage> {
  const at = atSql(now);
  const hourStart = periodStartSql("hour", at);
  const weekStart = periodStartSql("week", at);
  const monthStart = periodStartSql("month", at);
  const [row] = await rows<{ hour: number | null; week: number | null; month: number | null }>(
    db,
    sql`
      SELECT
        sum(cost) FILTER (WHERE created_at >= ${hourStart})::int AS hour,
        sum(from_daily) FILTER (WHERE created_at >= ${weekStart})::int AS week,
        sum(from_daily) FILTER (WHERE created_at >= ${monthStart})::int AS month
        FROM ai_search_charge
       WHERE user_id = ${userId}
         AND state IN ('reserved', 'settled')
         AND created_at >= LEAST(${weekStart}, ${monthStart})
         AND created_at <= ${at}
    `,
  );
  return { hour: row?.hour ?? 0, week: row?.week ?? 0, month: row?.month ?? 0 };
}

/** Bonus da yetmediginde kullaniciya gosterilecek pencere: en gec yenileneni. */
function exhaustedAllowanceWindow(input: {
  cost: number;
  weekRemaining: number;
  monthRemaining: number;
}): QuotaWindow {
  if (input.monthRemaining < input.cost) return "month";
  if (input.weekRemaining < input.cost) return "week";
  return "day";
}

export interface ChargeRecord {
  id: string;
  userId: number;
  operation: AiSearchOperation;
  state: AiSearchChargeState;
  day: string;
  fromDaily: number;
  fromBonus: number;
  imageUploadId: number | null;
  linkRequestId: string | null;
  createdAt: Date;
}

interface ChargeRow {
  id: string;
  user_id: string | number;
  operation: AiSearchOperation;
  state: AiSearchChargeState;
  day: string;
  from_daily: number;
  from_bonus: number;
  image_upload_id: string | number | null;
  link_request_id: string | null;
  created_at: string | Date;
}

const CHARGE_COLUMNS = sql.raw(
  "id, user_id, operation, state, day::text AS day, from_daily, from_bonus, image_upload_id, link_request_id, created_at",
);

function toRecord(row: ChargeRow): ChargeRecord {
  return {
    id: row.id,
    userId: Number(row.user_id),
    operation: row.operation,
    state: row.state,
    day: row.day,
    fromDaily: row.from_daily,
    fromBonus: row.from_bonus,
    imageUploadId: row.image_upload_id === null ? null : Number(row.image_upload_id),
    linkRequestId: row.link_request_id,
    createdAt: new Date(row.created_at),
  };
}

export async function getCharge(db: Database | Tx, chargeId: string): Promise<ChargeRecord | null> {
  const [row] = await rows<ChargeRow>(
    db,
    sql`SELECT ${CHARGE_COLUMNS} FROM ai_search_charge WHERE id = ${chargeId}`,
  );
  return row ? toRecord(row) : null;
}

export async function findActiveCharge(
  db: Database | Tx,
  userId: number,
): Promise<ChargeRecord | null> {
  const [row] = await rows<ChargeRow>(
    db,
    sql`SELECT ${CHARGE_COLUMNS} FROM ai_search_charge WHERE user_id = ${userId} AND state = 'reserved'`,
  );
  return row ? toRecord(row) : null;
}

async function findChargeByRequestKey(
  db: Database | Tx,
  userId: number,
  requestKey: string,
): Promise<ChargeRecord | null> {
  const [row] = await rows<ChargeRow>(
    db,
    sql`
      SELECT ${CHARGE_COLUMNS} FROM ai_search_charge
       WHERE user_id = ${userId} AND request_key = ${requestKey}
    `,
  );
  return row ? toRecord(row) : null;
}

export type ReserveSearchResult =
  | { status: "reserved"; charge: ChargeRecord }
  /** Ayni istek anahtari daha once kullanildi; yeni hak alinmadi. */
  | { status: "replay"; charge: ChargeRecord }
  /**
   * Hak yetmiyor. `hour`: saatlik patlama siniri (bonus asamaz); `day` /
   * `week` / `month`: o donemin hakki da bonus da yetmiyor.
   */
  | { status: "exhausted"; window: QuotaWindow }
  /** Bu kullanicinin hala suren bir pahali aramasi var. */
  | { status: "busy"; active: ChargeRecord };

export interface ReserveSearchInput {
  userId: number;
  operation: AiSearchOperation;
  requestKey: string;
  now?: Date;
}

/**
 * Hak ayirir. `busy` durumunda aktif harcamanin durum-bilgili uzlasmasi
 * `reconcile.ts`'tedir (`reserveSearchReconciling`).
 */
export async function reserveSearch(
  db: Database,
  input: ReserveSearchInput,
): Promise<ReserveSearchResult> {
  if (!isValidRequestKey(input.requestKey)) throw new InvalidRequestKeyError();
  const cost = AI_OPERATION_COST[input.operation];
  const limit = dailySearchLimit();
  const day = istanbulDaySql(input.now);
  const at = atSql(input.now);

  try {
    return await db.transaction(async (tx): Promise<ReserveSearchResult> => {
      // 1) Kilitler: once gunluk hak, sonra bonus (sabit sira).
      await tx.execute(sql`
        INSERT INTO ai_quota_day (user_id, day, daily_limit)
        VALUES (${input.userId}, ${day}, ${limit})
        ON CONFLICT (user_id, day) DO NOTHING
      `);
      const [quota] = await rows<{ day: string; daily_limit: number; used: number }>(
        tx,
        sql`
          SELECT day::text AS day, daily_limit, used FROM ai_quota_day
           WHERE user_id = ${input.userId} AND day = ${day}
          FOR UPDATE
        `,
      );
      if (!quota) throw new Error("ai_quota_day satiri kilitlenemedi");
      const bonusBalance = await lockBonusAccount(tx, input.userId);

      // 2) Kilitten sonra: tekrar mi, suren arama var mi?
      const previous = await findChargeByRequestKey(tx, input.userId, input.requestKey);
      if (previous) return { status: "replay", charge: previous };
      const active = await findActiveCharge(tx, input.userId);
      if (active) return { status: "busy", active };

      // 3) Pencereler (quota/policy.ts). Saatlik sinir bonusla da asilamaz.
      const usage = await readPeriodUsage(tx, input.userId, input.now);
      if (usage.hour + cost > SEARCH_RIGHTS_LIMITS.hour) {
        return { status: "exhausted", window: "hour" };
      }
      const weekRemaining = SEARCH_RIGHTS_LIMITS.week - usage.week;
      const monthRemaining = SEARCH_RIGHTS_LIMITS.month - usage.month;

      // 4) Once donem hakki (gun/hafta/ay kalanlarinin kucugu), sonra bonus.
      const split = splitCharge({
        cost,
        dailyLimit: quota.daily_limit,
        dailyUsed: quota.used,
        bonusBalance,
        periodRemaining: Math.min(weekRemaining, monthRemaining),
      });
      if (!split) {
        return {
          status: "exhausted",
          window: exhaustedAllowanceWindow({ cost, weekRemaining, monthRemaining }),
        };
      }

      const [created] = await rows<ChargeRow>(
        tx,
        sql`
          INSERT INTO ai_search_charge
            (user_id, operation, request_key, cost, day, from_daily, from_bonus, created_at)
          VALUES
            (${input.userId}, ${input.operation}, ${input.requestKey}, ${cost},
             ${quota.day}::date, ${split.fromDaily}, ${split.fromBonus}, ${at})
          RETURNING ${CHARGE_COLUMNS}
        `,
      );
      if (!created) throw new Error("ai_search_charge insert bos sonuc dondurdu");

      if (split.fromDaily > 0) {
        await tx.execute(sql`
          UPDATE ai_quota_day SET used = used + ${split.fromDaily}, updated_at = now()
           WHERE user_id = ${input.userId} AND day = ${quota.day}::date
        `);
      }
      if (split.fromBonus > 0) {
        const [bonus] = await rows<{ balance: number }>(
          tx,
          sql`
            UPDATE bonus_account SET balance = balance - ${split.fromBonus}, updated_at = now()
             WHERE user_id = ${input.userId}
            RETURNING balance
          `,
        );
        if (!bonus) throw new Error("bonus_account guncellenemedi");
        await tx.execute(sql`
          INSERT INTO bonus_ledger
            (user_id, delta, requested, balance_after, reason, idempotency_key, charge_id)
          VALUES
            (${input.userId}, ${-split.fromBonus}, ${-split.fromBonus}, ${bonus.balance},
             'search_charge', ${`charge:${created.id}`}, ${created.id})
        `);
      }
      return { status: "reserved", charge: toRecord(created) };
    });
  } catch (error) {
    // Kilitler bunu imkansiz kilmali; yine de kisit yakalarsa (islem geri
    // alindi, hicbir sey harcanmadi) ayni sonucu okunur bicimde dondur.
    const constraint = uniqueViolationConstraint(error);
    if (constraint === "ai_search_charge_request_key_unique") {
      const previous = await findChargeByRequestKey(db, input.userId, input.requestKey);
      if (previous) return { status: "replay", charge: previous };
    }
    if (constraint === "ai_search_charge_one_active") {
      const active = await findActiveCharge(db, input.userId);
      if (active) return { status: "busy", active };
    }
    throw error;
  }
}

export interface SettleOptions {
  imageUploadId?: number;
  linkRequestId?: string;
}

/** Basari: kesinlestirir. Ilk kez kesinlesiyorsa davet nitelenmesi ayni islemde. */
export async function settleCharge(
  db: Database,
  chargeId: string,
  options: SettleOptions = {},
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [settled] = await rows<{ user_id: string | number }>(
      tx,
      sql`
        UPDATE ai_search_charge
           SET state = 'settled', finalized_at = now(),
               image_upload_id = COALESCE(${options.imageUploadId ?? null}::bigint, image_upload_id),
               link_request_id = COALESCE(${options.linkRequestId ?? null}::uuid, link_request_id)
         WHERE id = ${chargeId} AND state = 'reserved'
        RETURNING user_id
      `,
    );
    if (!settled) return false;
    await qualifyReferralInTx(tx, { inviteeUserId: Number(settled.user_id), chargeId });
    return true;
  });
}

export type RefundReason =
  | "provider_error"
  | "provider_unavailable"
  | "internal_error"
  | "link_failed"
  | "link_stale"
  /** Ayirma ile kuyruk arasinda ayni link baskasi tarafindan acildi; yeni is yok. */
  | "link_reused"
  | "queue_unavailable";

/** Sonuc uretmeyen hata: ayrilan hakki tam bir kez geri verir. */
export async function refundCharge(
  db: Database,
  chargeId: string,
  reason: RefundReason,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [refunded] = await rows<{
      user_id: string | number;
      day: string;
      from_daily: number;
      from_bonus: number;
    }>(
      tx,
      sql`
        UPDATE ai_search_charge
           SET state = 'refunded', finalized_at = now(), refund_reason = ${reason}
         WHERE id = ${chargeId} AND state = 'reserved'
        RETURNING user_id, day::text AS day, from_daily, from_bonus
      `,
    );
    if (!refunded) return false;
    const userId = Number(refunded.user_id);

    if (refunded.from_daily > 0) {
      await tx.execute(sql`
        UPDATE ai_quota_day SET used = used - ${refunded.from_daily}, updated_at = now()
         WHERE user_id = ${userId} AND day = ${refunded.day}::date
      `);
    }
    if (refunded.from_bonus > 0) {
      await lockBonusAccount(tx, userId);
      // Iade tavana kirpilmaz: yalnizca alinani geri verir.
      const [bonus] = await rows<{ balance: number }>(
        tx,
        sql`
          UPDATE bonus_account SET balance = balance + ${refunded.from_bonus}, updated_at = now()
           WHERE user_id = ${userId}
          RETURNING balance
        `,
      );
      if (!bonus) throw new Error("bonus_account guncellenemedi");
      await tx.execute(sql`
        INSERT INTO bonus_ledger
          (user_id, delta, requested, balance_after, reason, idempotency_key, charge_id)
        VALUES
          (${userId}, ${refunded.from_bonus}, ${refunded.from_bonus}, ${bonus.balance},
           'search_refund', ${`refund:${chargeId}`}, ${chargeId})
      `);
    }
    return true;
  });
}

/** Fotograf aramasinin baglanti kaydini (`image_upload`) saglayici cagrisindan once yazar. */
export async function attachImageUpload(
  db: Database,
  chargeId: string,
  imageUploadId: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE ai_search_charge SET image_upload_id = ${imageUploadId}
     WHERE id = ${chargeId} AND state = 'reserved' AND operation = 'visual_search'
  `);
}

/** Link aramasinin istek kaydini kuyruga yazmadan once baglar. */
export async function attachLinkRequest(
  db: Database,
  chargeId: string,
  linkRequestId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE ai_search_charge SET link_request_id = ${linkRequestId}
     WHERE id = ${chargeId} AND state = 'reserved' AND operation = 'link_search'
  `);
}
