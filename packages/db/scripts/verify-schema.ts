/**
 * Iki seyi kanitlar:
 *
 * 1. Elle yazilan Drizzle semasi gercek semayla ortusuyor. Her tabloya Drizzle
 *    uzerinden SELECT atilir; kolon adi veya tipi ayrismissa sorgu patlar.
 * 2. Append-only kurali VERITABANINDA gecerli. `arilla_app` rolu ile
 *    `price_point` ve `variant_stock_event` uzerinde UPDATE/DELETE denenir;
 *    42501 (insufficient_privilege) beklenir. Gelmezse betik hata verir.
 *
 * Ikinci madde onemli: kural kod incelemesine degil motora birakildi, o yuzden
 * motorun gercekten uyguladigi her kosuda dogrulanir.
 */
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { createDatabase } from "../src/client.ts";
import * as schema from "../src/schema/index.ts";
import { ownerUrl, requireEnv, withClient } from "./lib.ts";

const APPEND_ONLY = ["price_point", "variant_stock_event"] as const;
const INSUFFICIENT_PRIVILEGE = "42501";
const FOREIGN_KEY_VIOLATION = "23503";

let failures = 0;

function fail(message: string): void {
  console.error(`  HATA: ${message}`);
  failures++;
}

// --- 1. Sema uyumu -----------------------------------------------------------
const db = createDatabase(ownerUrl());
const tables = Object.values(schema).filter((value) => is(value, PgTable));

console.log(`Sema uyumu: ${tables.length} tablo`);
for (const table of tables) {
  try {
    await db.select().from(table).limit(1);
  } catch (error) {
    fail(`${getTableName(table)} okunamadi — ${(error as Error).message}`);
  }
}
if (failures === 0) {
  console.log(`  ${tables.length} tablonun tamami Drizzle uzerinden okunabiliyor.`);
}

// --- 2. Append-only yetkileri ------------------------------------------------
console.log("Append-only yetkileri (arilla_app):");
await withClient(requireEnv("DATABASE_URL"), async (client) => {
  const { rows } = await client.query<{ user: string; super: boolean }>(
    "SELECT current_user AS user, usesuper AS super FROM pg_user WHERE usename = current_user",
  );
  const role = rows[0];
  if (!role) {
    fail("DATABASE_URL ile baglanan rol okunamadi.");
    return;
  }
  if (role.super) {
    fail(`${role.user} superuser — yetki kontrolleri atlanir, kural etkisiz kalir.`);
    return;
  }
  console.log(`  rol: ${role.user} (superuser degil)`);

  // WHERE false hicbir satira dokunmaz; yetki yine de PLANLAMA aninda kontrol
  // edilir, yani tablolar bos olsa da test gecerlidir.
  for (const table of APPEND_ONLY) {
    const statements = [
      `UPDATE ${table} SET in_stock = in_stock WHERE false`,
      `DELETE FROM ${table} WHERE false`,
    ];
    for (const statement of statements) {
      try {
        await client.query("BEGIN");
        await client.query(statement);
        await client.query("ROLLBACK");
        fail(`"${statement}" calisti — engellenmeliydi.`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        const code = (error as { code?: string }).code;
        if (code === INSUFFICIENT_PRIVILEGE) {
          console.log(`  ${statement} → 42501, engellendi`);
        } else {
          fail(`"${statement}" beklenmeyen hata verdi (${code}).`);
        }
      }
    }
  }

  // SELECT ve INSERT calismaya devam etmeli.
  try {
    await client.query("SELECT 1 FROM price_point LIMIT 1");
    await client.query("SELECT 1 FROM variant_stock_event LIMIT 1");
    console.log("  SELECT price_point, variant_stock_event → izinli");
  } catch (error) {
    fail(`SELECT engellendi — olmamaliydi: ${(error as Error).message}`);
  }

  try {
    await client.query("BEGIN");
    // offer_id -1 hicbir zaman var olmaz; testin tohum verisinden bagimsiz
    // olmasi icin boyle secildi. Bos veritabaninda da, dolu olaninda da ayni
    // sonucu verir: yetki VAR, yalnizca FK tutmuyor.
    await client.query(
      "INSERT INTO price_point (offer_id, observed_at, price, in_stock) VALUES (-1, now(), 1, true)",
    );
    await client.query("ROLLBACK");
    fail("INSERT var olmayan offer ile gecti — FK bekleniyordu.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const code = (error as { code?: string }).code;
    // FK ihlali = yetki VAR, sadece o offer yok. Aradigimiz sonuc bu.
    if (code === FOREIGN_KEY_VIOLATION) {
      console.log("  INSERT price_point → izinli (FK ihlali, yetki hatasi degil)");
    } else {
      fail(`INSERT beklenmeyen hata verdi (${code}).`);
    }
  }
});

if (failures > 0) {
  console.error(`\n${failures} dogrulama basarisiz.`);
  process.exit(1);
}
console.log("\nTum dogrulamalar gecti.");
process.exit(0);
