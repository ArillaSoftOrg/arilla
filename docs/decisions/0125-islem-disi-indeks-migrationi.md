# 0125 — İşlem dışı indeks migration'ı (`kind: concurrent`) ve sorgu ölçümü

## Karar

1. Yeni migration türü `-- kind: concurrent`. Çalıştırıcı (`scripts/migrate.ts`) bu
   dosyayı **işlem dışında**, ifade ifade çalıştırır. Yalnızca iki ifade serbesttir:
   `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <ad> ON ...` ve
   `DROP INDEX CONCURRENTLY IF EXISTS <ad>`. Lint (`migration-lint.ts`) başka her
   ifadeyi ve diğer türlerdeki `CONCURRENTLY`'yi reddeder.
2. Yarım kalan `CREATE INDEX CONCURRENTLY` geride **geçersiz** (`indisvalid = false`)
   bir indeks bırakır; `IF NOT EXISTS` onu sessizce geçerdi. Çalıştırıcı bu yüzden
   oluşturmadan önce aynı adlı geçersiz indeksi `DROP INDEX CONCURRENTLY` ile
   kaldırır ve oluşturduktan sonra geçerli olduğunu doğrular. Dosya, ancak bütün
   ifadeler bittiğinde `schema_migration`'a yazılır; yeniden koşu idempotenttir.
3. Kilit süresi ayrıdır: `MIGRATION_CONCURRENT_LOCK_TIMEOUT` (varsayılan 10 dk).
   CIC yazımı kilitlemez, fakat başlamadan önce açık işlemlerin bitmesini bekler;
   normal dosyaların 5 sn'lik süresi bu bekleyişi her uzun toplu işte düşürürdü.
4. Ölçüm: `pg_stat_statements` ayrı `monitoring` şemasında (migration 0081) ve
   `shared_preload_libraries` ile (`infra/vps/postgres/postgresql.conf`, yeniden
   başlatma ister). Rapor `pnpm db:health` (salt okunur): indekssiz FK, gereksiz ve
   kullanılmayan indeks, ölü satır, en pahalı 20 sorgu. Aynı yeniden başlatmayla
   yavaş sorgu günlüğü parametre değeri yazmaz (`log_parameter_max_length = 0`).

## Gerekçe

Katalog AliExpress/Admitad beslemeleriyle milyonlarca teklife büyüyor (karar 0111,
0124). İşlem içinde `CREATE INDEX` `offer` üzerinde yazımları dakikalarca durdurur;
5 sn'lik kilit süresiyle de dağıtım düşer. Önceki çözüm ("büyükse elle CONCURRENTLY,
migration `IF NOT EXISTS` ile boş geçer", 0030) elle adım ve unutulmuş geçersiz
indeks riski taşıyordu. Darboğaz önceliği tahminle değil ölçümle belirlenmeli; şimdiye
kadar sorgu düzeyinde ölçüm yoktu.

## Reddedilen

- Tüm migration'ları işlem dışı çalıştırmak: şema değişikliklerinin "hepsi ya da
  hiçbiri" garantisi kaybolur.
- Aynı dosyada şema ifadesi ve CONCURRENTLY karıştırmak: yarım kalırsa geri alınamaz;
  şema dosyası ve indeks dosyası ayrı numara alır.
- `pg_stat_statements`'ı `public` şemaya kurmak: 0010'daki varsayılan yetkiler
  uygulama rolüne sorgu metinlerini okutur ve şema doğrulamasını kirletirdi.
- Harici APM/izleme servisi: kişisel veri ve yurt dışı aktarım (CLAUDE.md), maliyet.
