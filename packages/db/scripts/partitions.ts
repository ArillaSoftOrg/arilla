/**
 * `price_point` aylik partition'larini uretir.
 *
 * Fiyat gecmisi geriye donuk uretilemez; eksik partition INSERT'i patlatir.
 * Bu yuzden partition'lar ONCEDEN acilir: icinde bulunulan ay + MONTHS_AHEAD.
 * Uc ay ileri uretmek, tek bir kacirilmis cron kosusunun veri kaybina
 * donusmesini engeller.
 *
 * `--check`: `price_point_default` bos mu diye bakar. Dolu ise KRITIK durumdur
 * — cron calismamis demektir — ve betik sifirdan farkli kodla cikar. Izleme
 * bu cikis kodunu kullanir. Bkz. docs/ops.md.
 */
import { ensureMonthlyPartitions } from "./ensure-partitions.ts";
import { ownerUrl, withClient } from "./lib.ts";

const MONTHS_AHEAD = 3;

await withClient(ownerUrl(), async (client) => {
  if (process.argv.includes("--check")) {
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
