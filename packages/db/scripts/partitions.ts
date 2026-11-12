/**
 * `price_point` aylik partition'larini uretir.
 *
 * Fiyat gecmisi geriye donuk uretilemez; eksik partition INSERT'i patlatir.
 * Bu yuzden partition'lar ONCEDEN acilir: icinde bulunulan ay + MONTHS_AHEAD.
 * Uc ay ileri uretmek, tek bir kacirilmis cron kosusunun veri kaybina
 * donusmesini engeller.
 *
 * `--check` (SALT OKUNUR; oturum `READ ONLY`, sahip kimligiyle bile yazamaz):
 * - `price_point_default` doluysa KRITIK (cikis 1): uretim calismamis, satirlar default'ta.
 * - Ufuk (karar 0188): bu ayin ya da gelecek ayin partition'i yoksa KRITIK (cikis 1) — veri
 *   default'a dusmeden en az bir ay once; politika ufkunun (bu ay + 3) gerisindeyse UYARI
 *   (cikis 0, stderr). Izleme cikis kodunu kullanir. Bkz. docs/ops.md.
 */
import { ensureMonthlyPartitions } from "./ensure-partitions.ts";
import { assertRemoteWriteConfirmed, ownerUrl, withClient } from "./lib.ts";
import { horizonStatus, MONTHS_AHEAD, partitionMonth } from "./partitions-lib.ts";

// `--check` salt okunur (izleme uzak veritabaninda da calisir); uretim yazar.
if (!process.argv.includes("--check")) assertRemoteWriteConfirmed("db:partitions");

await withClient(ownerUrl(), async (client) => {
  if (process.argv.includes("--check")) {
    // Kontrol ile sema degistiren uretim ayri: bu oturum hicbir sey yazamaz (DDL dahil).
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const { rows } = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM price_point_default",
    );
    const count = Number(rows[0]?.count ?? "0");
    if (count > 0) {
      console.error(
        `KRITIK: price_point_default icinde ${count} satir var. Aylik partition ` +
          "uretimi calismamis. Runbook: docs/ops.md.",
      );
      process.exitCode = 1;
      return;
    }
    console.log("price_point_default bos — beklenen durum.");

    const bounds = await client.query<{ bound: string }>(
      `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'price_point'::regclass`,
    );
    const months = bounds.rows.map((row) => partitionMonth(row.bound)).filter((m) => m !== null);
    const horizon = horizonStatus(months, new Date());
    if (horizon.level === "crit") {
      console.error(horizon.message);
      process.exitCode = 1;
    } else if (horizon.level === "warn") {
      console.error(horizon.message);
    } else {
      console.log(horizon.message);
    }
    return;
  }

  const now = new Date();
  const ahead = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + MONTHS_AHEAD, 1));
  const created = await ensureMonthlyPartitions(client, now, ahead);

  const { rows } = await client.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'price_point'::regclass
      ORDER BY c.relname`,
  );

  console.log(
    created.length > 0 ? `Olusturulan: ${created.join(", ")}` : "Yeni partition gerekmedi.",
  );
  console.log(`Mevcut partition'lar: ${rows.map((row) => row.relname).join(", ")}`);
});
