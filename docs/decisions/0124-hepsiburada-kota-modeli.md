# 0124 — Hepsiburada kota modeli: HTTP ve ürün hacmi, atomik rezervasyon

**Tarih:** 15 Ekim 2026
**Durum:** Kod hazır (migration 0075); merge/deploy ve production uygulaması yok. Hiçbir koşu başlatılmadı,
Hepsiburada'ya istek atılmadı.
**Bağlam:** 0117, 0120. Kullanıcı yeni kapsamı yazılı izne dayanarak bildirdi (belge incelenmedi; beyan olarak
saklanır, `permission_basis = declared_extended`).

## Karar

1. **Eski koşu sayısı kotası kaldırıldı:** 7 gün aralık ve ayda 4 koşu politikada `0` / `NULL`. Kolonlar silinmez;
   tetikleyici bu kısıtları yalnız tanımlıysa uygular. Tek açık koşu kuralı (`collection_run_one_open_uniq`) sürer.
2. **Yeni sınırlar** (`collection_source`, NULL = uygulanmaz): günlük 20.000 HTTP isteği, aylık 60.000 HTTP isteği.
   Ürün sayısı sınırsızdır (`monthly_max_products = NULL`, 16 Ekim 2026 kullanıcı kararı). Gün ve ay UTC'dir. Eski 1.000/gün ve 30.000/ay sınırları geçersizdir. Aylık istek
   hakkı, günlük tavan sürekli kullanılırsa en erken 3 günde biter (16 Ekim 2026 kullanıcı kararı: aylık 60.000).
   0070'in iki koruması silinmez: aralık tanımlıysa koşu penceresi aralıktan kısadır; sözlü / e-posta bildirimli
   izinde politika 7 gün ve ayda 4 koşunun dışına gevşetilemez (`collection_source_reported_scope`).
3. **İstek, gerçek HTTP'den ÖNCE rezerve edilir.** `reserveRequests` tek işlemde `collection_run.requests_reserved`
   değerini artırır; `collection_run_usage_guard` (SECURITY DEFINER, advisory kilit) günlük/aylık tavanı denetler ve
   `collection_usage_day` defterini yazar. Toplayıcı rezervasyon commit edilmeden kaynağa istek atmaz
   (`discovery-logic.ts`, `collector-logic.ts`). İstek atıldıktan sonra yazım başarısız olsa bile rezervasyon iade
   edilmez; kota aşılamaz. `requests_made` yalnız tamamlanan istektir (`requests_made <= requests_reserved`). Eski
   yol yalnız `requests_made` artırırsa tetikleyici farkı aynı kilitle rezerve eder. Çökme sonrası devamda bir istek
   yeniden rezerve edilir (muhafazakâr; eksik sayma yok).
4. **Ürün sayımı:** bir partide kabul edilen benzersiz geçerli kimlik (yeni + tekrar görülen) `products_counted`
   olarak parti yazımıyla aynı işlemde sayılır; yalnız izleme içindir, Hepsiburada'da kotayı sınırlamaz. Bir kaynakta
   `monthly_max_products` tanımlanırsa sığmayan parti reddedilir, hiçbir şey yazılmaz (genel yol, testli).
5. **Tükenmiş kota:** aylık ya da günlük istek hakkı bittiyse yeni koşu açılmaz
   (`collection_quota_*`), açık koşunun rezervasyonu da reddedilir. Panel "Başlatılamaz" yerine nedeni ve yenilenme
   zamanını gösterir; kota varken açık koşu "Devam edilebilir" sayılır.
6. **Gevşetilmeyenler:** en az 2 sn istek aralığı, engel (401/403/429/503, HTML) sonrası durma ve soğuma, onaylı bayt
   tavanı, veritabanı boyut tavanı, yalnız kimlik/ad/görsel/URL (fiyat yok; `price_state = unpriced`).
7. **Kapsam dışı:** ürün detay sayfası, fiyat toplama, `offer`/`price_point` değişikliği.

## Reddedilen

- Yalnız koşu sayısı limitini yükseltmek: gerçek yükü ölçmez.
- Kotayı yalnız uygulama kodunda tutmak: atlanabilir ve yarışa açık; kota veritabanı tetikleyicisindedir.
- `requests_made` güncellemesine dayalı sayım: istek atıldıktan sonra yazım çökerse kota sayılmaz.

## Doğrulanmayanlar

16 Ekim 2026: migration main şemasına + tohum veriye uygulandı, ikinci koşu idempotent, `db:verify` geçti; TS
katalog/yönetim entegrasyon testleri (`quota.integration.test.ts` dahil) ve Python `test_hb_intake.py` yerel
PostgreSQL'de geçti. Gerçek ağ trafiği ve kaynağın izin beyanı doğrulanmadı.
