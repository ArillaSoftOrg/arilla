/**
 * Doğruluk değerlendirmesi: temsilî örnekleme + elle etiketleme iş akışı (Faz 5).
 *
 * Ölçülen şey, katalogdaki KATEGORİ/MARKA atamasının doğruluğudur (veri setinin
 * boyutları buradan gelir). Etiketleyici bir ürünün başlığına ve atanan değere
 * bakar; kullanıcı, olay ya da kişi bilgisi görmez ve etikete yazılmaz.
 *
 * İş akışı:
 *  1. `drawAccuracySample`: build'in dönemindeki olaylarda geçen ürünlerden,
 *     tohumlu ve belirleyici (md5 sıralı) örnek; kategori başına üst sınırla
 *     tabakalı, böylece büyük kategori örneği domine etmez.
 *  2. `listPendingLabels` / `recordAccuracyLabel`: yönetici doğru/yanlış/emin değil.
 *  3. Kalite raporunda `classification_accuracy`: en az 30 karar yoksa NOT_MEASURED;
 *     varsa Wilson alt güven sınırı. Kural: ilk karar kesindir (yeniden etiketlenmez).
 */
import { createHash } from "node:crypto";
import type { Database, DiDatasetKey, DiLabelField, DiLabelVerdict } from "@arilla/db";
import { sql } from "drizzle-orm";
import { recordAdminEvent } from "../admin/audit.ts";
import { type AdminActor, assertCapability } from "../admin/capabilities.ts";
import { DataIntelligenceInputError } from "./builder-errors.ts";
import type { AccuracyInputs } from "./quality.ts";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const num = (v: unknown): number => Number(v ?? 0);

/** Aynı veri seti + dönemin tüm sürümlerindeki etiketler (ürün düzeyi, kişisiz). */
export async function readAccuracy(
  tx: Pick<Database, "execute">,
  key: DiDatasetKey,
  start: string,
  end: string,
): Promise<AccuracyInputs> {
  const r = await tx.execute(sql`
    SELECT count(*) FILTER (WHERE l.verdict IS NOT NULL) AS labeled,
           count(*) FILTER (WHERE l.verdict = 'correct') AS correct,
           count(*) FILTER (WHERE l.verdict = 'incorrect') AS incorrect,
           count(*) FILTER (WHERE l.verdict = 'unsure') AS unsure
      FROM di_accuracy_label l
      JOIN di_dataset_build b ON b.id = l.build_id
     WHERE b.dataset_key = ${key} AND b.period_start = ${start}::date AND b.period_end = ${end}::date
  `);
  const row = (r.rows[0] ?? {}) as Record<string, unknown>;
  return {
    labeled: num(row.labeled),
    correct: num(row.correct),
    incorrect: num(row.incorrect),
    unsure: num(row.unsure),
  };
}

const SAMPLE_MAX = 200;
const SEED_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface SampleResult {
  field: DiLabelField;
  requested: number;
  inserted: number;
}

/** Hangi alanın doğruluğu ölçülür: marka veri seti → marka, diğerleri → kategori. */
export function sampledField(key: DiDatasetKey): DiLabelField {
  return key === "brand_interest_trends" ? "brand" : "category";
}

export async function drawAccuracySample(
  db: Database,
  actor: AdminActor,
  buildId: number,
  opts: { size: number; seed?: string },
): Promise<SampleResult> {
  assertCapability(actor, "data.build");
  const size = Math.trunc(opts.size);
  if (!Number.isInteger(size) || size < 1 || size > SAMPLE_MAX) {
    throw new DataIntelligenceInputError(`örnek boyutu 1–${SAMPLE_MAX}`);
  }
  const seed = opts.seed ?? createHash("sha256").update(`${buildId}`).digest("hex").slice(0, 16);
  if (!SEED_RE.test(seed)) throw new DataIntelligenceInputError("geçersiz tohum");

  return db.transaction(async (tx) => {
    const build = await tx.execute(sql`
      SELECT dataset_key, period_start::text AS ps, period_end::text AS pe, status
        FROM di_dataset_build WHERE id = ${buildId}`);
    const b = build.rows[0] as
      | { dataset_key: DiDatasetKey; ps: string; pe: string; status: string }
      | undefined;
    if (!b) throw new DataIntelligenceInputError("sürüm bulunamadı");
    if (b.status !== "ready")
      throw new DataIntelligenceInputError("yalnızca hazır sürümden örnek çekilir");
    const field = sampledField(b.dataset_key);
    const assigned =
      field === "brand"
        ? sql`br.slug`
        : sql`array_to_string((string_to_array(c.path,'/'))[1:2],'/')`;
    const perStratumCap = Math.max(1, Math.ceil(size * 0.2));
    const inserted = await tx.execute(sql`
      WITH prods AS (
        SELECT DISTINCT p.id AS product_id, ${assigned} AS assigned
          FROM user_activity_event ue
          LEFT JOIN offer o ON o.id = ue.offer_id
          JOIN product p ON p.id = COALESCE(ue.product_id, o.product_id)
          LEFT JOIN category c ON c.id = p.category_id
          LEFT JOIN brand br ON br.id = p.brand_id
         WHERE ue.kind IN ('product_viewed','merchant_exit')
           AND ue.created_at >= (${b.ps}::date)::timestamp AT TIME ZONE 'UTC'
           AND ue.created_at <  (${b.pe}::date)::timestamp AT TIME ZONE 'UTC'
           AND ${assigned} IS NOT NULL
           AND (c.id IS NULL OR c.is_discoverable)
      ), ranked AS (
        SELECT product_id, assigned,
               row_number() OVER (PARTITION BY assigned ORDER BY md5(${seed} || product_id::text)) AS rn,
               md5(${seed} || product_id::text) AS h
          FROM prods
      ), picked AS (
        SELECT product_id, assigned FROM ranked WHERE rn <= ${perStratumCap}
         ORDER BY h LIMIT ${size}
      )
      INSERT INTO di_accuracy_label (build_id, product_id, field, assigned_value, sample_seed)
      SELECT ${buildId}, product_id, ${field}, left(assigned, 120), ${seed} FROM picked
      ON CONFLICT (build_id, product_id, field) DO NOTHING
      RETURNING id`);
    await recordAdminEvent(tx, {
      actor,
      action: "data.accuracy_sample",
      targetType: "data_build",
      targetId: buildId,
      after: { field, requested: size, inserted: inserted.rows.length },
    });
    return { field, requested: size, inserted: inserted.rows.length };
  });
}

export interface PendingLabel {
  id: number;
  field: DiLabelField;
  assignedValue: string;
  productTitle: string;
  productSlug: string;
}

export async function listPendingLabels(
  db: Database,
  actor: AdminActor,
  buildId: number,
  limit = 20,
): Promise<PendingLabel[]> {
  assertCapability(actor, "data.read");
  const n = Math.min(Math.max(1, Math.trunc(limit)), 100);
  const r = await db.execute(sql`
    SELECT l.id, l.field, l.assigned_value, p.title, p.slug
      FROM di_accuracy_label l JOIN product p ON p.id = l.product_id
     WHERE l.build_id = ${buildId} AND l.verdict IS NULL
     ORDER BY l.id LIMIT ${n}`);
  return (r.rows as Record<string, unknown>[]).map((row) => ({
    id: num(row.id),
    field: row.field as DiLabelField,
    assignedValue: String(row.assigned_value),
    productTitle: String(row.title),
    productSlug: String(row.slug),
  }));
}

const VERDICTS: readonly DiLabelVerdict[] = ["correct", "incorrect", "unsure"];

/** İlk karar kesindir: karar verilmiş etiket değiştirilemez. `false` = zaten etiketli ya da yok. */
export async function recordAccuracyLabel(
  db: Database,
  actor: AdminActor,
  labelId: number,
  verdict: string,
  now: Date = new Date(),
): Promise<boolean> {
  assertCapability(actor, "data.build");
  if (!VERDICTS.includes(verdict as DiLabelVerdict)) {
    throw new DataIntelligenceInputError("geçersiz karar");
  }
  return db.transaction(async (tx) => {
    const r = await tx.execute(sql`
      UPDATE di_accuracy_label
         SET verdict = ${verdict}, labeled_by = ${actor.userId}, labeled_at = ${now}
       WHERE id = ${labelId} AND verdict IS NULL
       RETURNING build_id`);
    const row = r.rows[0] as { build_id: number } | undefined;
    if (!row) return false;
    await recordAdminEvent(tx, {
      actor,
      action: "data.accuracy_label",
      targetType: "data_build",
      targetId: num(row.build_id),
      after: { labelId, verdict },
    });
    return true;
  });
}
