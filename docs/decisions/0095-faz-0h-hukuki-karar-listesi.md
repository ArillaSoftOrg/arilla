# 0095 — Faz 0-H: hukuki onay bekleyen kararlar (liste)

**Tarih:** 10 Ekim 2026 · **Durum:** taslak, **hiçbir madde uygulanmadı**

Veri mimarisi ve AI planı (Faz 0-T/1–6) sırasında bulunan, **teknik düzeltmeyle
çözülemeyen** ve hukuki görüş ya da ürün sahibinin kararı gerektiren kalemler.
Bu dosya karar vermez; karar sahibine sunulacak listeyi sabitler. Her madde
karara bağlanınca ayrı bir karar dosyası (ya da bu dosyaya "karar" notu)
yazılır, sonra kod gelir. İlke: toplama izni işleme izni değildir; toplulaştırılmış
veri de kaynağında kişisel veri işlemeye dayanır.

## A. Saklama süreleri

| # | Konu | Bugünkü durum (kanıt) | Karar gerektiren | Uygulanmadı çünkü |
|---|---|---|---|---|
| A1 | `click` ve `conversion` | `docs/kvkk.md` satır 25: "5 yıl (mali mevzuat)". Silen kod **yok**. Hesap silinince `user_id` NULL'lanır, `session_id` kalır. | (1) Mali mevzuat dayanağı ve gerçek süre. (2) Süre dolunca **silme mi, kimliksizleştirme mi** (`session_id`/`user_id` NULL, satır kalsın). (3) `conversion` komisyon/ödeme kaydıyla bağlı; ayrı süre mi. (4) `click_id` ile eşleşen `conversion` varken tek taraflı silme izin verilir mi. | Silme geri alınamaz ve hukuki tercih; üründe en eski `click` 2026 tarihli, **ilk uygun satır ≈ 2031**, acil risk yok. Teknik seçenekler: aylık partition `DROP` (silme) ya da toplu `UPDATE ... SET session_id = NULL` (kimliksizleştirme); `click` bugün partition'sız. |
| A2 | Anonim `feedback`, `form_response`, `form_skip` | `kvkk.md` 382/391/403: "henüz tanımlı değil". | Süre ve silme yöntemi. | Süre belirlemek hukuki. |
| A3 | `link_resolution_request` (`url_raw`, `source` JSONB) | Purge yok; `kvkk.md` veri tablosunda satırı yok. | Veri kategorisi, süre, `url_raw` kişisel veri taşıyabilir mi. | Süre ve kategori hukuki. |
| A4 | `api_usage` (`session_id`, `user_id`) | Silme yok; uygulama rolünde DELETE de yok (migration 0046). | Süre; hesap silinince `session_id` kalıyor. | Süre hukuki; yetki değişikliği migration ister. |
| A5 | `image_upload` ham dosya "en fazla 30 gün" | Hiçbir kod `object_key` yazmıyor: ham dosya **hiç saklanmıyor**; silinecek bir şey yok. | Yalnızca `kvkk.md` metninin gerçekle hizalanması. | Kod gerektirmez; metin hukuki. |

## B. Rıza ve aydınlatma

| # | Konu | Kanıt | Karar gerektiren |
|---|---|---|---|
| B1 | Kayıtta varsayılan açık rıza (`signup_default`, `granted=true`: gezinme geçmişi, kişiselleştirme, anonim keşif) | `core/account/onboarding.ts`; `kvkk.md:73-75`; karar 0060 (ürün sahibi talebi, önceden işaretli kutu). | Varsayılan işaretli rıza açık rıza sayılır mı; değilse akış. |
| B2 | Gizlilik metni ↔ kod | Metin "kullanıcıya bağlı arama geçmişi tutmayız" derken kod rızalı `query_norm` yazıyor ve "son aramalar" gösteriyor. Saklama tablosu eksik (180 gün olay, 1 yıl `auth_event`, sohbet 90 gün, `click` 5 yıl). `PRIVACY_NOTICE_VERSION = 2026-09-26` ≠ yayın tarihi (7 Ekim). | Metin içeriği ve sürüm tarihi (içerik hukuki). |
| B3 | Alıcı listesi eksik | R2/Cloudflare, SMTP ve SMS sağlayıcısı gizlilik sayfasında adlandırılmamış. | Alıcı/aktarım listesi. |
| B4 | Yeni amaçlar için ayrı rıza türleri | Bugün yok. | `personalization`, `model_training` gibi ayrı `user_consent.kind` ve metinleri; impression sayacı (`exposure_day`) ve `session_hash` için dayanak. |

## C. Üçüncü taraf ve aktarım

| # | Konu | Kanıt | Karar gerektiren |
|---|---|---|---|
| C1 | Canlı bayrak durumu | Yerel `.env.vercel` (production çekimi, 8 Ekim) `GEMINI_REALTIME_ENABLED="true"` gösterdi; `kvkk.md`/`ops.md` bu yolun hukuki değerlendirme olmadan açılmayacağını söylüyor. `CHAT_DISCOVERY_ENABLED`, `CHAT_IMAGE_ENABLED` bilinmiyor. | Canlıdaki gerçek değerleri doğrulama ve gerekirse kapatma (ürün sahibi + hukuk). |
| C2 | Yurt dışı aktarım (m.9) | Gemini, Jina, GA4, Vercel, Upstash, Supabase. Gemini m.9 sözleşmesi `kvkk.md`'de "imzalandı"; kanıt depoda yok. | Aktarım dayanağı/sözleşme kanıtı, Kurum bildirimi, VERBİS. |
| C3 | Sohbet içeriği ve görsel eki | Gizlilik/aydınlatma metinleri sohbet içeriğini ve 90 gün saklamayı anlatmıyor (`kvkk.md:414,433`). | Bayrak açılmadan önce metin ve rıza. |

## D. Analitik ve model eğitimi

| # | Konu | Karar gerektiren |
|---|---|---|
| D1 | Anonimlik eşiği | **k≥20 tek başına yeterli değildir.** Sınıf içi çeşitlilik (l-diversity), küçük hücre baskılama, tekil çıkarım/bağlanabilirlik/çıkarım testleri ve makul yeniden-kimliklendirme değerlendirmesi gerekir; geçemeyen tablo takma adlı kişisel veri sayılır. Kabul edilecek ölçüt ve "anonim" ilan edilecek tablolar hukukla belirlenir. |
| D2 | Toplulaştırılmış veri | Toplu tablolar (`search_query_day`, ileride `exposure_day`) için bile ham kişisel verinin toplanıp toplulaştırılması bir işlemedir: hukuki sebep, amaç, aydınlatma, saklama kaynak için tanımlanır. |
| D3 | Eğitim kümeleri | `user_id` tutulmaz. Silme talebinde modelin yeniden eğitilemediği durumlar için politika. Sohbet/görsel verisi eğitimde **kullanılmaz** (varsayılan). |
| D4 | Davranışsal profilleme | Kişisel profil/kişiselleştirilmiş sıralama için açık rıza kapsamı; yaş, gelir, cinsiyet **çıkarımı yapılmaz**, yalnızca isteğe bağlı beyan ve ayrı rızayla. |

## Uygulama kuralı
[H] işaretli hiçbir kalem bu listeden karar çıkmadan koda dökülmez. Teknik
düzeltmeler (HMAC'li IP özeti, migration koruması, çift görüntüleme düzeltmesi
vb.) bu listeden ayrıdır ve ayrı PR'lardadır.

## Reddedilen alternatif
Süreleri ve dayanakları kodda varsayılan değerlerle ("makul görünen") tanımlayıp
sonra hukukla hizalamak: silme geri alınamaz ve metin–kod uyumsuzluğu zaten
bugünkü ana risktir.
