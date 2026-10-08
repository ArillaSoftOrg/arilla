# 0085 — Yönetim Faz C: analitik merkez (AI, yolculuk, affiliate, kalite özetleri)

**Tarih:** 9 Ekim 2026
**Durum:** Kabul edildi

Var olan veriyle, yeni telemetri ve migration OLMADAN yönetimi işletim
analitiği merkezine genişletir. Yetki haritası (0039), rıza ve analitik
kuralları (0049, events.md), sohbet gizliliği (0074, 0078, 0079), maliyet
tahmini (0082) ve tasarım sistemi (0083, 0084) değişmez.

## Karar

1. **Yeni yetenekler (yalnızca yönetici):** `ai.read`, `analytics.read`,
   `affiliate.read`. Her sayfa `requireCapability`, her core fonksiyonu
   `assertCapability` ile; reddedilen çağrı veritabanına gitmez (test). Kapsam
   kaydı ve yetki matrisi güncellendi.
2. **`/yonetim/ai`** (`getAiOperationsOverview`): işlem × model çağrı,
   önbellek, token (`units`), tahmini maliyet ve fiyatlanmamış çağrı; günlük
   döküm; sağlayıcı günlük tavanı (kod sabiti + bugünkü sayım); arama hakkı
   kotası (`ai_search_charge` durumları, bugünkü `ai_quota_day` doluluğu);
   sorgu yorumu sonuç dağılımı; sohbet konuşma/mesaj SAYILARI. Kullanıcıya göre
   gruplanmaz, içerik seçilmez. Gecikme, hata oranı ve Redis kota reddi
   "ölçülmüyor" diye etiketlenir.
3. **`/yonetim/yolculuk`** (`getUserJourneyOverview`): kayıt/giriş
   (`auth_event`), rıza oranları (kişi başına SON karar), kimliksiz arama
   (`search_query_day`), rızalı huni örneklemi (`user_activity_event`),
   fiyat alarmı, davet, bonus defteri. Her sayı veri temeli rozeti taşır (tam
   sayım / rızalı örneklem / ölçülmüyor). **Küçük hücre kuralı:** örneklem
   hücresinde 5'ten az farklı kişi varsa olay ve kişi sayısı gizlenir.
   `click` (attribution) ve `product_view` (kullanıcının kendi geçmişi)
   bilerek kullanılmaz.
4. **`/yonetim/affiliate`** (`getAffiliateOverview`): `click` yalnızca
   attribution toplamı (mağaza, yüzey, kanal, gün; oturum ve kullanıcı
   seçilmez), affiliate kapsamı (durum, deeplink, komisyon tanımlı mı).
   Dönüşüm ve gelir "dış kaynak gerekli": `conversion`'a yazan entegrasyon
   yok; satır sayısı dürüstçe gösterilir, tahmin yok. Mağaza tablosu duruma
   göre süzülür ve sayfalanır.
5. **Mevcut sayfalara özetler, yeni ekran yok:** arama tanısına 7 günlük
   arama/sonuçsuz/yedek/netleştirme ve yorum kabul oranı
   (`getSearchQualitySummary`); eşleştirme geçmişine 30 günlük yöntem ve skor
   bandına göre onay oranı (`getMatchingAccuracy`); katalog kalitesine
   tazelik, stok, görselsiz teklif, galeri durumu ve liste fiyatı şişirme
   sayısı (`getCatalogFreshness`, eşik `STALE_OFFER_DAYS`).
6. **Genel bakış:** üç gerçek kart eklendi (12 kart, 3 × 4): mağaza çıkışı
   (7 gün, 2 sn sınırlı; aşılırsa "Hesaplanamadı"), aktif sohbet (7 gün,
   `conversation_last_message_idx`), aktif fiyat alarmı (kısmi indeks).
   Model maliyeti kartı artık `/yonetim/ai`'ye gider.
7. **Sorgu sınırları:** hepsi `readOnly` (salt okunur işlem +
   `statement_timeout` 5–8 sn) ve 1/7/30 günlük pencereyle sınırlı.

## Performans ölçümü

Tek kullanımlık konteynerde sentetik hacimle (1M `api_usage`, 1M `click`,
500k `chat_message`, 500k `user_activity_event`, 200k `user_consent`,
200k `offer`, 300k `auth_event`), 30 günlük pencere: `api_usage` 60 ms
(`api_usage_daily_idx`), `click` mağazaya göre 87 ms (sıralı tarama),
`chat_message` 28 ms (sıralı), rıza son kararı 75 ms (sıralı), örneklem 54 ms
(`user_activity_event_created_idx`), `auth_event` 5 ms (indeks), katalog
tazeliği 170 ms (200k teklif, sıralı). Hepsi zaman aşımının çok altında ama
`click`, `chat_message`, `ai_search_charge`, `referral`, `match_candidate`
(`reviewed_at`) ve `offer` tazeliği hacimle doğrusal büyür.

## Sınırlar ve Faz E

- Zaman indeksi gerekenler (migration onayı): `click (created_at)`,
  `chat_message (created_at)`, `ai_search_charge (created_at)`,
  `match_candidate (reviewed_at) WHERE status IN ('accepted','rejected')`.
  Katalog tazeliği çok büyük katalogda toplu işle önceden hesaplanmalı.
- Ölçülmeyen telemetri: model çağrısı sonucu ve gecikmesi, girdi/çıktı token
  ayrımı, sohbet tur sonucu, Redis kota reddi, anonim ziyaret ve kimliksiz
  huni, işlemsel e-posta teslimi, kırık görsel, bot tıklaması, KVKK dışa
  aktarım kaydı.
- Dış entegrasyon: affiliate dönüşüm/gelir, sağlayıcı faturası, hata izleme.

## Reddedilen alternatifler

- **Huni için `click` ya da `product_view` kullanmak:** events.md ve 0049
  bunu açıkça yasaklar.
- **Küçük örneklemi göstermek:** 1–4 kişilik hücre kişiyi tanımlanabilir kılar.
- **Dönüşümü tahmin etmek (çıkış × varsayılan oran):** gerçek olmayan metrik.
- **Ayrı "arama kalitesi" ve "katalog sağlığı" ekranları:** mevcut tanı
  sayfaları genişletildi; çift ekran yok.
