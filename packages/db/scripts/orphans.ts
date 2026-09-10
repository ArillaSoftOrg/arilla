/**
 * Polimorfik `target_id` yetimlerini raporlar.
 *
 * `embedding` ve `generated_content` uzerinde foreign key KURULAMAZ
 * (`target_id` bir tabloya degil `target_type`'a gore ucune birden isaret
 * eder). Migration 0014 silme yonunu trigger'a bagladi; geriye kalan yollar
 * — yazma yonu, kapatilmis trigger, taninmayan `target_type` — yalnizca
 * olculerek gorulur.
 *
 * `--check`: yetim varsa sifirdan farkli kodla cikar. Izleme bu cikis kodunu
 * kullanir; `pnpm db:partitions --check` ile ayni desen. Bkz. docs/ops.md.
 */

import { ownerUrl, withClient } from "./lib.ts";
import { countQueryScoped, findOrphans, totalOrphans } from "./orphan-check.ts";

await withClient(ownerUrl(), async (client) => {
  const groups = await findOrphans(client);
  const total = totalOrphans(groups);
  const check = process.argv.includes("--check");

  if (total === 0) {
    const queryScoped = await countQueryScoped(client);
    console.log("Yetim satir yok — beklenen durum.");
    if (queryScoped > 0) {
      console.log(`  (${queryScoped} adet target_type='query' satiri var; bunlar yetim sayilmaz.)`);
    }
    return;
  }

  const lines = groups.map(
    (group) =>
      `  ${group.tablo} · target_type='${group.targetType}' · ${group.sebep}: ${group.adet}`,
  );

  if (check) {
    console.error(`KRITIK: ${total} yetim satir. Runbook: docs/ops.md.`);
    console.error(lines.join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log(`${total} yetim satir:`);
  console.log(lines.join("\n"));
  console.log(
    "\nSilme yolu trigger ile kapali (0014). Yetim varsa arıza YAZMA yonunde ya da " +
      "trigger devre disi. Runbook: docs/ops.md.",
  );
});
