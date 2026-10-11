/**
 * Karar 0103: veri zekâsı - gerçek (yalıtılmış) Postgres. Yalnızca kendi `di-t-`
 * fixture'larını ve 2019'un tamamlanmış haftasını kullanır; sonunda siler.
 */
import type { Database } from "@arilla/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminActor, AdminForbiddenError } from "../admin/capabilities.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import { drawAccuracySample, recordAccuracyLabel } from "./accuracy.ts";
import { buildDataset, DataIntelligenceInputError } from "./builder.ts";
import {
  cancelExport,
  ExportRefusedError,
  getExportFile,
  requestExport,
  runExport,
  startExport,
} from "./export.ts";
import { getCollectionAudit, getDataIntelligenceOverview } from "./overview.ts";
import { CLOSED_POLICY, type DataIntelligencePolicy } from "./policy.ts";

const S = Date.now().toString(36).slice(-6);
const START = "2019-03-04"; // Pazartesi
const END = "2019-03-11";
const NOW = new Date("2019-04-01T00:00:00Z");
let admin: AdminActor = { userId: 0, role: "admin" };
let moderator: AdminActor = { userId: 0, role: "moderator" };
const open: DataIntelligencePolicy = {
  buildEnabled: true,
  exportEnabled: true,
  clearedSources: new Set(["user_activity_event"]),
};
const noLegal: DataIntelligencePolicy = { ...open, clearedSources: new Set() };

type Q = { rows: Record<string, unknown>[] };

describe("veri zekâsı - entegrasyon", () => {
  let db: Database;
  let userIds: number[] = [];
  const q = async (text: string): Promise<Q> => (await db.execute(sql.raw(text))) as unknown as Q;

  beforeAll(async () => {
    db = getTestDb();
    await withOwnerClient(async (c) => {
      const actors = await c.query(
        `INSERT INTO app_user (display_name, role) VALUES ('di_t_${S}','admin'),('di_t_${S}','moderator') RETURNING id, role`,
      );
      for (const r of actors.rows as { id: number; role: "admin" | "moderator" }[]) {
        if (r.role === "admin") admin = { userId: r.id, role: "admin" };
        else moderator = { userId: r.id, role: "moderator" };
      }
      const merchantId = (
        await c.query(
          "INSERT INTO merchant (slug,name,domain,source_type) VALUES ($1,$1,$2,'xml_feed') RETURNING id",
          [`di_t_${S}`, `di-t-${S}.example`],
        )
      ).rows[0].id;
      const cat = async (slug: string, path: string, discoverable = true) =>
        (
          await c.query(
            "INSERT INTO category (slug,name,path,is_discoverable) VALUES ($1,'t',$2,$3) RETURNING id",
            [slug, path, discoverable],
          )
        ).rows[0].id;
      const catOk = await cat(`di-t-moda-${S}`, `di-t-moda-${S}/canta`);
      const catSmall = await cat(`di-t-ev-${S}`, `di-t-ev-${S}`);
      const catHidden = await cat(`di-t-gizli-${S}`, `di-t-gizli-${S}`, false);
      const brand = (
        await c.query("INSERT INTO brand (slug,name,name_norm) VALUES ($1,'T',$1) RETURNING id", [
          `di-t-marka-${S}`,
        ])
      ).rows[0].id;
      const mkProduct = async (n: string, categoryId: number) =>
        (
          await c.query(
            "INSERT INTO product (slug,title,brand_id,category_id) VALUES ($1,$2,$3,$4) RETURNING id",
            [`di-t-p-${n}-${S}`, `Ürün ${n}`, brand, categoryId],
          )
        ).rows[0].id;
      const pOk = await mkProduct("ok", catOk);
      const pSmall = await mkProduct("small", catSmall);
      const pHidden = await mkProduct("hidden", catHidden);
      const offer = (
        await c.query(
          "INSERT INTO offer (merchant_id,product_id,external_id,url,title_raw,current_price,currency) VALUES ($1,$2,'x1','https://e.example/x','t',150000,'TRY') RETURNING id",
          [merchantId, pOk],
        )
      ).rows[0].id;
      const u = await c.query(
        `INSERT INTO app_user (display_name) SELECT 'di_t_${S}' FROM generate_series(1,130) RETURNING id`,
      );
      userIds = u.rows.map((r: { id: number }) => r.id);
      const ids = `ARRAY[${userIds.join(",")}]::bigint[]`;
      const at = "'2019-03-05 10:00:00+00'::timestamptz";
      const views = (product: number, upTo: number, spread: boolean) =>
        c.query(
          `INSERT INTO user_activity_event (user_id,kind,product_id,created_at,event_id,schema_version)
           SELECT u, 'product_viewed', ${product}, ${at} ${spread ? "+ (i * interval '1 second')" : ""}, gen_random_uuid(), 2
             FROM unnest(${ids}) WITH ORDINALITY AS t(u,i) WHERE i <= ${upTo}`,
        );
      await views(pOk, 120, true); // 120 kişi
      await views(pSmall, 5, false); // eşik altı
      await views(pHidden, 60, false); // hassas kategori
      // Tekrarlı (eski şema, event_id yok): aynı kişi/ürün/an iki kez
      for (let k = 0; k < 2; k++) {
        await c.query(
          "INSERT INTO user_activity_event (user_id,kind,product_id,created_at,schema_version) VALUES ($1,'product_viewed',$2,'2019-03-06 09:00:00+00',1)",
          [userIds[0], pOk],
        );
      }
      // Bot: tek kişi, aynı gün 400 olay
      await c.query(
        `INSERT INTO user_activity_event (user_id,kind,product_id,created_at,event_id,schema_version)
         SELECT ${userIds[129]}, 'product_viewed', ${pOk}, '2019-03-07 00:00:00+00'::timestamptz + (g * interval '1 second'), gen_random_uuid(), 2
           FROM generate_series(1,400) g`,
      );
      // 40 kişi mağaza çıkışı; biri bozuk fiyat (5 kuruş)
      for (let i = 0; i < 40; i++) {
        const click = await c.query(
          `INSERT INTO click (session_id,offer_id,product_id,channel,price_at_click,created_at)
           VALUES ($1,$2,$3,'web',$4,'2019-03-06 12:00:00+00') RETURNING id`,
          [`s${i}`, offer, pOk, i === 39 ? 5 : 150000],
        );
        await c.query(
          `INSERT INTO user_activity_event (user_id,kind,offer_id,click_id,created_at,event_id,schema_version)
           VALUES ($1,'merchant_exit',$2,$3,'2019-03-06 12:00:00+00',gen_random_uuid(),2)`,
          [userIds[i], offer, click.rows[0].id],
        );
      }
    });
  });

  afterAll(async () => {
    await withOwnerClient(async (c) => {
      const builds = `SELECT id FROM di_dataset_build WHERE period_start IN ('${START}','2018-03-05')`;
      await c.query(`DELETE FROM di_accuracy_label WHERE build_id IN (${builds})`);
      await c.query(`DELETE FROM di_export WHERE build_id IN (${builds})`);
      await c.query(`DELETE FROM di_dataset_build WHERE period_start IN ('${START}','2018-03-05')`);
      await c.query("DELETE FROM user_activity_event WHERE user_id = ANY($1)", [userIds]);
      await c.query(
        "DELETE FROM click WHERE session_id ~ '^s[0-9]+$' AND created_at < '2020-01-01'",
      );
      await c.query(
        "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug=$1)",
        [`di_t_${S}`],
      );
      await c.query("DELETE FROM product WHERE slug LIKE $1", [`di-t-p-%-${S}`]);
      await c.query("DELETE FROM merchant WHERE slug=$1", [`di_t_${S}`]);
      await c.query("DELETE FROM brand WHERE slug=$1", [`di-t-marka-${S}`]);
      await c.query("DELETE FROM category WHERE slug LIKE $1", [`di-t-%-${S}`]);
      await c.query("DELETE FROM app_user WHERE id = ANY($1)", [userIds]);
      await c.query("DELETE FROM app_user WHERE id = ANY($1)", [[admin.userId, moderator.userId]]);
    });
  });

  const req = (datasetKey: Parameters<typeof buildDataset>[2]["datasetKey"]) => ({
    datasetKey,
    periodStart: START,
    periodEnd: END,
  });

  it("kapalı politikada kaynak okunmaz: blocked kaydı", async () => {
    const r = await buildDataset(db, admin, req("category_trends"), CLOSED_POLICY, { now: NOW });
    expect(r.status).toBe("blocked");
    expect(r.statusReason).toBe("build_disabled");
    expect(r.rowCount).toBe(0);
  });

  it("kaynağı olmayan veri seti satır uydurmaz", async () => {
    const r = await buildDataset(db, admin, req("alternative_search_trends"), open, { now: NOW });
    expect(r.status).toBe("blocked");
    expect(r.statusReason).toBe("no_event_source");
    expect(r.rowCount).toBe(0);
  });

  it("yetkisiz ve geçersiz dönem reddedilir", async () => {
    await expect(
      buildDataset(db, moderator, req("category_trends"), open, { now: NOW }),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
    await expect(
      buildDataset(db, admin, { ...req("category_trends"), periodStart: "2019-03-05" }, open, {
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DataIntelligenceInputError);
    await expect(
      buildDataset(db, admin, { ...req("category_trends"), periodEnd: "2099-01-04" }, open, {
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DataIntelligenceInputError);
  });

  it("boş dönemde insufficient_data", async () => {
    const r = await buildDataset(
      db,
      admin,
      { datasetKey: "category_trends", periodStart: "2018-03-05", periodEnd: "2018-03-12" },
      open,
      { now: NOW },
    );
    expect(r.status).toBe("insufficient_data");
    expect(r.statusReason).toBe("no_events_in_period");
  });

  let categoryBuildId = 0;
  it("kategori seti: tekrar/bot/küçük grup/hassas elenir, k-eşikli satır üretir", async () => {
    const r = await buildDataset(db, admin, req("category_trends"), open, { now: NOW });
    expect(r.status).toBe("ready");
    categoryBuildId = r.id;
    const row = (
      await q(`SELECT rows, quality_report, anonymity_ok FROM di_dataset_build WHERE id = ${r.id}`)
    ).rows[0] as {
      rows: Record<string, unknown>[];
      quality_report: { metrics: { key: string; status: string }[] };
      anonymity_ok: boolean;
    };
    const text = JSON.stringify(row.rows);
    expect(text).toContain(`di-t-moda-${S}/canta`);
    expect(text).not.toContain("di-t-ev-");
    expect(text).not.toContain("di-t-gizli-");
    const view = row.rows.find((x) => x.event_type === "product_view");
    expect(view?.users_band).toBe("100+");
    expect(row.rows.every((x) => !("users" in x) && !("user_id" in x))).toBe(true);
    const m = row.quality_report.metrics;
    expect(m.find((x) => x.key === "event_loss_rate")?.status).toBe("NOT_MEASURED");
    expect(m.find((x) => x.key === "classification_accuracy")?.status).toBe("NOT_MEASURED");
    expect(m.find((x) => x.key === "source_duplicate_share")).toBeDefined();
    expect(row.anonymity_ok).toBe(true);
    // Bot kişisi ve tekrar sayaçları rapora yansır
    const dup = await q(
      `SELECT quality_report->'metrics' AS m FROM di_dataset_build WHERE id=${r.id}`,
    );
    expect(JSON.stringify(dup.rows[0])).toContain("elendi");
  });

  it("aynı girdi iki kez: aynı içerik özeti, yeni sürüm numarası", async () => {
    const a = await buildDataset(db, admin, req("category_trends"), open, { now: NOW });
    expect(a.status).toBe("ready");
    const rows = (
      await q(
        `SELECT version, content_sha256 FROM di_dataset_build WHERE dataset_key='category_trends' AND period_start='${START}' AND status='ready' ORDER BY id`,
      )
    ).rows as { version: string; content_sha256: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.content_sha256).toBe(rows[1]?.content_sha256);
    expect(rows[0]?.version).not.toBe(rows[1]?.version);
  });

  it("fiyat seti yalnızca merchant_exit; bozuk fiyat elenir; marka seti çalışır", async () => {
    const p = await buildDataset(db, admin, req("price_range_trends"), open, { now: NOW });
    expect(p.status).toBe("ready");
    const res = (await q(`SELECT rows, quality_report FROM di_dataset_build WHERE id=${p.id}`))
      .rows[0] as {
      rows: Record<string, unknown>[];
      quality_report: { metrics: { key: string; value: number }[] };
    };
    expect(
      res.rows.every((x) => x.event_type === "merchant_exit" && x.price_band === "1000-2500"),
    ).toBe(true);
    expect(res.quality_report.metrics.find((x) => x.key === "price_validity")?.value).toBeLessThan(
      1,
    );
    const b = await buildDataset(db, admin, req("brand_interest_trends"), open, { now: NOW });
    expect(b.status).toBe("ready");
  });

  it("değişmez: uygulama rolü sürümü güncelleyemez/silemez", async () => {
    await expect(
      q(`UPDATE di_dataset_build SET row_count = 0 WHERE id = ${categoryBuildId}`),
    ).rejects.toThrow();
    await expect(q(`DELETE FROM di_dataset_build WHERE id = ${categoryBuildId}`)).rejects.toThrow();
  });

  it("dışa aktarım: onay/bayrak/yetki yoksa reddedilir ve denetime yazılır", async () => {
    await expect(requestExport(db, admin, categoryBuildId, noLegal)).rejects.toMatchObject({
      reason: "legal_not_cleared",
    });
    await expect(requestExport(db, admin, categoryBuildId, CLOSED_POLICY)).rejects.toMatchObject({
      reason: "export_disabled",
    });
    await expect(requestExport(db, moderator, categoryBuildId, open)).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
    const audit = await withOwnerClient((c) =>
      c.query(
        "SELECT count(*)::int AS n FROM admin_audit_event WHERE action='data.export' AND target_id=$1 AND after->>'outcome'='refused'",
        [String(categoryBuildId)],
      ),
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it("dışa aktarım: tamamlanır, manifest ve SHA-256 tutarlı, tekrar üretim aynı bayt", async () => {
    const out = await requestExport(db, admin, categoryBuildId, open, { now: NOW });
    expect(out.status).toBe("completed");
    expect(out.manifest.map((f) => f.name)).toEqual([
      "data.csv",
      "metadata.json",
      "data_dictionary.json",
      "quality_report.json",
      "SHA256SUMS",
    ]);
    const csv = await getExportFile(db, admin, out.exportId, "data.csv", open);
    const csv2 = await getExportFile(db, admin, out.exportId, "data.csv", open);
    expect(csv.body).toBe(csv2.body);
    expect(csv.sha256).toBe(out.manifest[0]?.sha256);
    expect(csv.body.split("\n")[0]).toBe("week_start,category_path,event_type,events,users_band");
    expect(csv.body).not.toMatch(/user_id|email|@|session/i);
    const sums = await getExportFile(db, admin, out.exportId, "SHA256SUMS", open);
    expect(sums.body).toContain(csv.sha256);
    await expect(
      getExportFile(db, admin, out.exportId, "../../etc/passwd", open),
    ).rejects.toMatchObject({ reason: "invalid_file" });
    await expect(
      getExportFile(db, moderator, out.exportId, "data.csv", open),
    ).rejects.toBeInstanceOf(AdminForbiddenError);
    await expect(
      getExportFile(db, admin, out.exportId, "data.csv", CLOSED_POLICY),
    ).rejects.toMatchObject({ reason: "export_disabled" });
  });

  it("iptal edilen export: cancelled, kısmi çıktı yok, indirilemez", async () => {
    const id = await startExport(db, admin, categoryBuildId, open, NOW);
    const ac = new AbortController();
    ac.abort();
    const out = await runExport(db, admin, id, open, { signal: ac.signal, now: NOW });
    expect(out.status).toBe("cancelled");
    expect(out.manifest).toEqual([]);
    await expect(getExportFile(db, admin, id, "data.csv", open)).rejects.toMatchObject({
      reason: "export_not_completed",
    });
    const id2 = await startExport(db, admin, categoryBuildId, open, NOW);
    expect(await cancelExport(db, admin, id2, NOW)).toBe(true);
    expect(await cancelExport(db, admin, id2, NOW)).toBe(false);
  });

  it("başarısız export: onay çalışma anında kaybolursa failed + hata sınıfı", async () => {
    const id = await startExport(db, admin, categoryBuildId, open, NOW);
    const out = await runExport(db, admin, id, noLegal, { now: NOW });
    expect(out.status).toBe("failed");
    expect(out.errorClass).toBe("legal_not_cleared");
    await expect(getExportFile(db, admin, id, "data.csv", open)).rejects.toBeInstanceOf(
      ExportRefusedError,
    );
  });

  it("bütünlük: saklanan satırlar özetle uyuşmuyorsa export başarısız", async () => {
    const b = await buildDataset(db, admin, req("category_trends"), open, { now: NOW });
    await withOwnerClient((c) =>
      c.query(
        "UPDATE di_dataset_build SET rows = jsonb_set(rows, '{0,events}', '999999') WHERE id=$1",
        [b.id],
      ),
    );
    const out = await requestExport(db, admin, b.id, open, { now: NOW });
    expect(out.status).toBe("failed");
    expect(out.errorClass).toBe("integrity_mismatch");
  });

  it("doğruluk iş akışı: örnekle, etiketle, ilk karar kesin", async () => {
    const s = await drawAccuracySample(db, admin, categoryBuildId, { size: 5 });
    expect(s.inserted).toBeGreaterThan(0);
    const again = await drawAccuracySample(db, admin, categoryBuildId, { size: 5 });
    expect(again.inserted).toBe(0);
    const lab = await withOwnerClient((c) =>
      c.query("SELECT id FROM di_accuracy_label WHERE build_id=$1 LIMIT 1", [categoryBuildId]),
    );
    const id = lab.rows[0].id as number;
    expect(await recordAccuracyLabel(db, admin, id, "correct")).toBe(true);
    expect(await recordAccuracyLabel(db, admin, id, "incorrect")).toBe(false);
    await expect(recordAccuracyLabel(db, admin, id, "bogus")).rejects.toBeInstanceOf(
      DataIntelligenceInputError,
    );
    await expect(recordAccuracyLabel(db, moderator, id, "correct")).rejects.toBeInstanceOf(
      AdminForbiddenError,
    );
  });

  it("panel okumaları: toplanmayan olay not_collected; hukuki durum asla cleared değil", async () => {
    const audit = await getCollectionAudit(db, admin);
    expect(audit.find((a) => a.key === "alternative_preference")?.status).toBe("not_collected");
    expect(audit.find((a) => a.key === "product_card_click")?.status).toBe("not_collected");
    expect(audit.every((a) => (a.licensingStatus as string) !== "cleared")).toBe(true);
    const ov = await getDataIntelligenceOverview(db, admin, open);
    expect(ov.datasets).toHaveLength(4);
    expect(ov.datasets.find((d) => d.key === "alternative_search_trends")?.producible).toBe(false);
    expect(JSON.stringify(ov)).not.toContain('"rows"');
    await expect(getCollectionAudit(db, moderator)).rejects.toBeInstanceOf(AdminForbiddenError);
  });
});
