# 0107 — İnternet ürün araması: Google Search Suggestions çubuğu ve sağlayıcı seçenekleri

Durum: öneri (karar bekliyor). Kod değişikliği yok; ücretli servis/abonelik açılmadı.

## Soru

Karar 0102'deki internet aramasında Google Search Suggestions çubuğu
kaldırılabilir mi? Dupe.com benzeri, yalnızca ürün kartlarından oluşan bir
deneyim için hangi arama/ürün verisi kaynağı kullanılabilir?

## Sonuç (kısa)

1. **Gemini'nin Google Search grounding'i kullanıldığı sürece çubuk kaldırılamaz.**
   Gemini API şartları, grounding sonuçlarının Search Suggestions ile birlikte,
   değiştirilmeden gösterilmesini ister; çubuğu gizlemek şartları ihlaldir. Bu
   yüzden bu kod yolunda çubuk bilerek duruyor (`web-search-view.tsx`,
   `service.ts`: öneri yoksa sonuç gösterilmez).
2. **Çubuğu kaldırmanın tek meşru yolu, Google Search grounding'i bırakmaktır.**
   Yani ürün keşfini başka bir kaynaktan almak; Gemini yalnızca analiz ve
   eşleştirmede kalır (kural 1 istisnası aynı çağrı sayısıyla sürer).
3. **Bugün, abonelik açmadan ve şartları ihlal etmeden bu kaynağı seçip bağlayabileceğim
   bir API yok.** Aşağıdaki seçeneklerin hiçbiri "Türkiye mağazalarını kapsayan +
   ürün bağlantısı/görsel/fiyat + düşük maliyet + şartlara uygun" dörtlüsünü birlikte
   sağlamıyor. Gerçek alan şeması doğrulanmamış bir bağdaştırıcıyı koda gömmek,
   daha önce yaşadığımız hatanın (gerçek yanıt biçimi bilinmeden yazılan çözüm)
   tekrarı olur; bu yüzden uydurma bir sağlayıcı kodu yazılmadı.

## Seçenekler

| Seçenek | Ürün + görsel + fiyat | TR kapsamı | Maliyet | Şartlar / risk | Değerlendirme |
|---|---|---|---|---|---|
| **Gemini Google Search grounding (mevcut)** | Model satırı + Google atfı; görsel/fiyat mağaza sayfasından (PR #117–#119) | Geniş (web) | 5000 sorgu/ay ücretsiz, sonra 14 USD/1000 + token | Çubuk **zorunlu**, önbellek/izleme yasak | Çalışıyor; çubuk kalır |
| **Google Custom Search JSON API** | `pagemap` ile kısmen | Site listesiyle | 100/gün ücretsiz, 5 USD/1000 | **Yeni müşteriye kapalı, 1 Ocak 2027'de kapanıyor** (üçüncü taraf kaynaklara göre; Google sayfasından teyit edilmeli) | Elenir |
| **Vertex AI Search (≤50 alan adı)** | Yapılandırılmış veri mümkün, doğrulanmadı | Seçilen 50 mağaza | Kullanım bazlı | Google Cloud kurulumu gerekir; çıktı biçimi/şartlar doğrulanmadı | Araştırılacak aday |
| **Google Shopping'i çeken SERP API'leri** (SerpApi, Serper vb.) | Fiyat+görsel+bağlantı hazır | İyi | ~0,3–15 USD/1000 | Google sonuçlarını kazıma: Google şartlarıyla çelişir, hukuki risk | **Önerilmez** |
| **Mağaza kazıyıcı servisleri** (Apify vb.) | Var | Trendyol/Hepsiburada/n11 | ~1–10 USD/1000 ürün | Mağaza kullanım koşulları ve bot engellerini aşma; CLAUDE.md "scraping birincil kaynak olmaz" | **Reddedilir** |
| **Affiliate ürün beslemeleri (Admitad vb.) → katalog** | Besleme: bağlantı, görsel, fiyat, stok; izinli | Programa göre (başvuru/onay gerekir) | Komisyon modeli (maliyetsiz) | Temiz; başvuru ve onay süreci | **Önerilen uzun vadeli çözüm** |

## Kodda mevcut durum

- Repoda Admitad'a özel bir entegrasyon **yok**; yalnızca ağdan bağımsız
  `services/ingest/collect/sources/network_dump.py` (affiliate ağ dökümü
  taşıma) ve bootstrap Shopify kataloğu var. Ana sayfa içeriği Admitad öncesi
  demo veridir (`HOMEPAGE_DEMO_CONTENT`).
- Yani "başka API'ye geçmek" şu an koda sığacak bir iş değil, bir **iş geliştirme
  adımı** (program onayı + feed şeması) ve ardından mevcut katalog hattıdır.

## Önerilen mimari

1. **Kısa vadeli (şu anki durum):** Grounding'i çubukla birlikte tut. Çubuk kartların
   altında tek bir sandbox çerçevesidir; istenirse yalnızca yerleşimi/boyutu
   (şartlara uygun biçimde, içerik değiştirilmeden) sadeleştirilebilir.
   Görsel/fiyat/mağaza bağlantısı korunur (PR #117–#119).
2. **Orta vadeli:** Admitad (veya benzeri) ağdan Türkiye mağaza beslemelerini
   `services/ingest` hattıyla kataloğa al. Katalog zaten görsel, fiyat ve
   komisyonlu bağlantı verir, Search Suggestions gerektirmez, `click` kaydı
   üretir (kural 8). Gemini bu hatta eşleştirme/özellik çıkarımı için kalır
   (kural 3: sonuçlar saklanır).
3. **Geçiş kapısı:** Katalog kapsamı yeterli olunca internet araması (grounding)
   `WEB_SEARCH_ENABLED=false` ile kapatılır; çubuk kendiliğinden kalkar.
   Arayüzdeki "İnternetteki seçenekler" bölümü yalnızca grounding açıkken çizilir.
4. **Alternatif sağlayıcı gerekirse:** sağlayıcıyı bir arayüz arkasına almak
   (`WebGroundingClient` benzeri) ancak gerçek bir sağlayıcı seçilip örnek yanıtları
   doğrulandıktan sonra yapılmalıdır; öncesinde yazılan bağdaştırıcı tahmindir.

## Karar için gerekenler (kullanıcıya)

- Admitad (veya Awin/Impact) başvurusu ve Türkiye mağaza programlarının onayı.
- İsteniyorsa Vertex AI Search için Google Cloud projesi ve 50 mağaza listesi
  (örnek yanıtlarla doğrulanır, sonra karar verilir).
- Hukuk: SERP/kazıyıcı sağlayıcılar kullanılmayacaksa bu kayıt kapanır.

## Reddedilen alternatifler

- Çubuğu CSS/iframe ile gizlemek veya küçültüp okunamaz kılmak: Gemini API
  şartlarının ihlali.
- Google sonuçlarını kazıyan üçüncü taraf API: Google şartlarıyla çelişir.
- Mağaza kazıyıcı servisleri: mağaza şartları ve bot engellerinin aşılması.
- Doğrulanmamış bir "yedek sağlayıcı" kodunu şimdiden eklemek.
