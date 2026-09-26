/**
 * Uc seyi kanitlar:
 *
 * 1. Elle yazilan Drizzle semasi gercek semayla ortusuyor. Her tabloya Drizzle
 *    uzerinden SELECT atilir; kolon adi veya tipi ayrismissa sorgu patlar.
 * 2. Append-only kurali VERITABANINDA gecerli. `arilla_app` rolu ile
 *    `price_point`, `variant_stock_event` ve `admin_audit_event` uzerinde
 *    UPDATE/DELETE denenir;
 *    42501 (insufficient_privilege) beklenir. Gelmezse betik hata verir.
 * 3. Polimorfik `target_id` butunlugu ayakta (migration 0014): trigger'lar
 *    yerinde ve ETKIN, DELETE ve TRUNCATE yollari gercekten temizliyor,
 *    su anda yetim satir yok.
 *
 * Ortak gerekce: bu kurallarin hicbiri kod incelemesine birakilmadi, motora
 * verildi — o yuzden motorun gercekten uyguladigi her kosuda dogrulanir.
 * Ucuncu madde B3'te elle yakalanan bir arizanin kalici kapisidir.
 */
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { createDatabase } from "../src/client.ts";
import * as schema from "../src/schema/index.ts";
import { isLocal, ownerUrl, requireEnv, withClient } from "./lib.ts";
import { findOrphans, totalOrphans } from "./orphan-check.ts";

/** Tablo → UPDATE denemesinde kendine atanacak (degismeyen) kolon. */
const APPEND_ONLY = {
  price_point: "in_stock",
  variant_stock_event: "in_stock",
  admin_audit_event: "reason",
} as const;
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
  for (const [table, column] of Object.entries(APPEND_ONLY)) {
    const statements = [
      `UPDATE ${table} SET ${column} = ${column} WHERE false`,
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

// --- 3. Polimorfik butunluk (migration 0014) ---------------------------------
// B3'te bulunan ariza: `embedding.target_id` bir foreign key DEGIL, o yuzden
// `TRUNCATE offer ... RESTART IDENTITY CASCADE` vektorleri geride birakti ve
// kimlikler yeniden dagitilinca eski vektorler BASKA urunlere yapisti. Hata
// elle yakalanmisti; burasi onu kalici bir kapiya baglar.
console.log("Polimorfik butunluk (embedding, generated_content):");
await withClient(ownerUrl(), async (client) => {
  // 3a. Dort trigger da var ve ETKIN mi. `tgenabled`: O = origin (etkin),
  // D = disabled. Devre disi birakilmis bir trigger sessizce hicbir sey yapmaz.
  const { rows: triggers } = await client.query<{ tgname: string; tgenabled: string }>(
    `SELECT tgname, tgenabled FROM pg_trigger
      WHERE NOT tgisinternal AND tgname LIKE '%_polymorphic_%'
      ORDER BY tgname`,
  );
  const expected = [
    "offer_polymorphic_delete",
    "offer_polymorphic_truncate",
    "product_polymorphic_delete",
    "product_polymorphic_truncate",
  ];
  for (const name of expected) {
    const trigger = triggers.find((row) => row.tgname === name);
    if (!trigger) {
      fail(`${name} trigger'i yok — migration 0014 uygulanmamis.`);
    } else if (trigger.tgenabled !== "O") {
      fail(`${name} devre disi (tgenabled=${trigger.tgenabled}).`);
    }
  }
  if (failures === 0) {
    console.log(`  ${expected.length} trigger yerinde ve etkin.`);
  }

  // 3b. DELETE yolu gercekten temizliyor mu. Tek kullanimlik satirlar acilir,
  // silinir, sonuc olculur ve ROLLBACK ile hicbir iz birakilmaz. Tohum
  // verisinden bagimsizdir: bos veritabaninda da ayni sonucu verir.
  const ZERO_VECTOR = "('[1' || repeat(',0', 767) || ']')::vector";
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ offer_id: string; product_id: string }>(`
      WITH m AS (
        INSERT INTO merchant (slug, name, domain, source_type)
        VALUES ('verify-probe', 'Verify Probe', 'verify.probe.invalid', 'xml_feed')
        RETURNING id
      ), p AS (
        INSERT INTO product (slug, title) VALUES ('verify-probe-urun', 'Verify Probe')
        RETURNING id
      ), o AS (
        INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw)
        SELECT m.id, p.id, 'verify-probe-1', 'https://verify.probe.invalid/1', 'Verify Probe'
          FROM m, p
        RETURNING id, product_id
      )
      SELECT o.id::text AS offer_id, o.product_id::text AS product_id FROM o
    `);
    const probe = rows[0];
    if (!probe) throw new Error("probe satirlari acilamadi");

    for (const [type, id] of [
      ["offer", probe.offer_id],
      ["product", probe.product_id],
    ] as const) {
      await client.query(
        `INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
         VALUES ($1, $2, 'image', 'verify-probe', ${ZERO_VECTOR})`,
        [type, id],
      );
      await client.query(
        `INSERT INTO generated_content
           (target_type, target_id, kind, model_version, content, input_hash)
         VALUES ($1, $2, 'description', 'verify-probe', '{}'::jsonb, 'verify-probe')`,
        [type, id],
      );
    }

    const remaining = async (type: string, id: string): Promise<number> => {
      const { rows: counted } = await client.query<{ adet: string }>(
        `SELECT (
            (SELECT count(*) FROM embedding         WHERE target_type = $1 AND target_id = $2) +
            (SELECT count(*) FROM generated_content WHERE target_type = $1 AND target_id = $2)
         )::text AS adet`,
        [type, id],
      );
      return Number(counted[0]?.adet ?? "0");
    };

    if ((await remaining("offer", probe.offer_id)) !== 2) {
      fail("probe satirlari yazilamadi — testin kendisi bozuk.");
    }

    await client.query("DELETE FROM offer WHERE id = $1", [probe.offer_id]);
    const afterOffer = await remaining("offer", probe.offer_id);
    if (afterOffer !== 0) {
      fail(`offer silindi ama ${afterOffer} polimorfik satir kaldi — trigger calismadi.`);
    } else {
      console.log("  DELETE offer → bagli embedding/generated_content temizlendi");
    }

    await client.query("DELETE FROM product WHERE id = $1", [probe.product_id]);
    const afterProduct = await remaining("product", probe.product_id);
    if (afterProduct !== 0) {
      fail(`product silindi ama ${afterProduct} polimorfik satir kaldi — trigger calismadi.`);
    } else {
      console.log("  DELETE product → bagli embedding/generated_content temizlendi");
    }

    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    fail(`DELETE yolu probu patladi: ${(error as Error).message}`);
  }

  // 3c. TRUNCATE yolu — B3'te asil yanan yol. Islem icinde guvenlidir ama
  // ACCESS EXCLUSIVE kilit alir ve CASCADE ile bircok tabloya yayilir, o
  // yuzden yalnizca YEREL veritabaninda kosar. Atlandiginda ATLANDIGI YAZILIR;
  // sessizce gecmis gibi gorunmez.
  if (!isLocal(ownerUrl())) {
    console.log("  TRUNCATE yolu ATLANDI (yerel veritabani degil, kilit alinmaz).");
  } else {
    try {
      await client.query("BEGIN");
      const { rows: before } = await client.query<{ adet: string }>(
        "SELECT count(*)::text AS adet FROM embedding WHERE target_type = 'offer'",
      );
      await client.query(
        `INSERT INTO embedding (target_type, target_id, kind, model_version, vector)
         VALUES ('offer', 987654321, 'text', 'verify-probe', ${ZERO_VECTOR})`,
      );
      await client.query("TRUNCATE offer CASCADE");
      const { rows: after } = await client.query<{ adet: string }>(
        "SELECT count(*)::text AS adet FROM embedding WHERE target_type = 'offer'",
      );
      if (Number(after[0]?.adet ?? "-1") !== 0) {
        fail(`TRUNCATE offer sonrasi ${after[0]?.adet} offer vektoru kaldi — B3 ariza duruyor.`);
      } else {
        console.log(
          `  TRUNCATE offer CASCADE → ${Number(before[0]?.adet ?? "0") + 1} offer vektoru temizlendi`,
        );
      }
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      fail(`TRUNCATE yolu probu patladi: ${(error as Error).message}`);
    }
  }

  // 3d. Su anda yetim yok. Trigger'in kapatmadigi yollari (yazma yonu,
  // taninmayan target_type) olcer; `pnpm db:orphans --check` ile ayni sorgu.
  const orphans = await findOrphans(client);
  const total = totalOrphans(orphans);
  if (total > 0) {
    fail(
      `${total} yetim satir var: ` +
        orphans.map((g) => `${g.tablo}/${g.targetType} ${g.sebep} ${g.adet}`).join(", "),
    );
  } else {
    console.log("  Yetim satir yok.");
  }
});

if (failures > 0) {
  console.error(`\n${failures} dogrulama basarisiz.`);
  process.exit(1);
}
console.log("\nTum dogrulamalar gecti.");
process.exit(0);
