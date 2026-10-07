# 0072 — Ürün fiyat özeti yazma işleminde yenilenir; `offer_count` = aktif mağaza

**Tarih:** 7 Ekim 2026
**Durum:** Kabul edildi.

## Bağlam

`product.min_price`, `max_price`, `offer_count`, `in_stock_count` yalnızca
elle çalışan `python -m similarity --prices` ile yazılıyordu. Toplama ve
eşleştirme yeni ürünü varsayılanlarla (`0`, `NULL`) bırakıyordu. Üretimde
9.137 ürün bayattı: kart fiyatı canlı tekliften gösterip "0 mağaza" diyordu,
bütçe süzgeci (`p.min_price`) bu ürünleri hiç bulmuyordu. Elle onarıldı.

Ayrıca özet pasif mağazanın tekliflerini sayıyordu, arama (`best_offer`) ise
saymıyor. Aynı mağazanın aynı ürüne birden fazla aktif kaydı da olabiliyor
(katalog kalitesi bulgusu). Bu durumda kart iki mağaza diyor, mağaza ise bir.

## Karar

1. **Anlam:** yalnızca aktif mağazanın fiyatlı aktif teklifi sayılır.
   `offer_count` = farklı mağaza sayısı, `in_stock_count` = stokta olan
   mağaza sayısı. Kolon adları migration gerektirmesin diye korunur.
   Tüketiciler denetlendi:
   - Kullanıcı arayüzü zaten "N mağaza" diyor.
   - `> 0` kapıları (alternatifler, görsel ve link arama, keşfet) aramayla
     aynı tekliflere bakar.
   - Site haritasının "≥ 2" kuralının amacı karşılaştırmadır.
   - Yönetim etiketleri "mağaza" olarak düzeltildi.
2. **Yenileme yazma işleminin içinde,** yalnızca dokunulan ürünler için. Aynı
   SQL iki yerde durur: `services/ingest/db/product_aggregates.py` ve
   `packages/core/src/product/refresh-aggregates.ts`. İkisi birbirini
   çağıramaz (CLAUDE.md mimari sınır), birlikte değişir. Yenilenen yollar:
   - toplama koşusu (fiyat, stok, aktiflik; tam dökümde pasifleşenler dahil)
   - kullanıcı linki
   - eşleştirme (bağlama ya da yeni ürün)
   - yönetimde eşleştirme onayı
   - yönetimde mağaza aç/kapat
3. **Onarım:** `python -m similarity --prices` elle onarım olarak kalır. Ayrıca
   günlük Vercel cron'u (`/api/cron/refresh-product-aggregates`, 23:45 UTC,
   `job_run.job = product_aggregates`, gecikme eşiği 30 saat) atlanmış yolları
   bir gün içinde düzeltir.

## Reddedilen

- **Veritabanı tetikleyicisi:** her teklif yazımında satır başına iş yapar,
  toplama işini yavaşlatır ve migration ister.
- **Paylaşılan SQL fonksiyonu (migration):** tek kopya sağlar ama dağıtım
  sırası riski getirir (kod, fonksiyon yokken çalışırsa toplama durur).
- **Kartta canlı mağaza sayısı:** yalnızca etiketi düzeltir. Bayat `min_price`
  ürünü bütçe aramasından gizlemeye devam eder.
