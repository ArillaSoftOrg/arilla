# 0102 — Veri zekâsı MVP (toplulaştırılmış eğilim veri setleri)

**Tarih:** 11 Ekim 2026
**Durum:** Kabul edildi; üretim ve dışa aktarım **hukuki onay gelene kadar kapalı**.

B2B lisanslanabilecek, kişisel veri içermeyen istatistiksel veri ürünlerinin
altyapısı. Müşteriye açık API ya da otomatik dış aktarım **yoktur**. Mevcut
olay (`user_activity_event`, 0036/0061), denetim (`admin_audit_event`) ve AI
değerlendirme (`dataset_snapshot` 0060 — AI fixture'ları içindir, karıştırılmaz)
altyapısı yeniden kurulmadı.

## Karar

1. **Gerçek durum denetimi** (`COLLECTION_AUDIT`, `/yonetim/veri-zekasi`).
   Toplananlar: ürün görüntüleme, mağaza çıkışı (rızalı kopya + attribution).
   Kısmi: arama (yalnızca `query_norm`; kategori/marka/fiyat yok), görsel arama
   (yalnızca `ai_search_charge` hizmet kaydı). **Toplanmayan:** ürün kartı
   tıklaması, benzer ürün araması, alternatif tercihi (`alternative_clicked`
   tanımlı ama yazılmaz; `click.source_similarity_kind` hep NULL).
2. **Dört veri seti, üçü üretilebilir:** `category_trends`,
   `brand_interest_trends`, `price_range_trends`. `alternative_search_trends`
   kaynağı olmadığı için `blocked / no_event_source` kaydı bırakır; satır
   uydurulmaz. Olay türleri (`product_view`, `merchant_exit`) ayrı satırlardır;
   arama/gösterim/tıklama/satın alma birbirine toplanmaz. Fiyat bandı yalnızca
   çıkış anı fiyatından (`click.price_at_click`); `click` burada kaynak değil,
   rızalı `merchant_exit`'in `click_id`'si üzerinden öznitelik okumasıdır
   (events.md: `click` davranışsal kaynak olmaz).
3. **Yazma kapıları (varsayılan kapalı):** `DATA_INTELLIGENCE_BUILD_ENABLED`,
   `DATA_INTELLIGENCE_EXPORT_ENABLED` ve kaynak başına
   `DATA_INTELLIGENCE_CLEARED_SOURCES` (hukuki onayın kaydı). Rızalı analitik
   olayların üçüncü tarafa lisanslanması için dayanak doğrulanmadı (0049
   analitik rızası hizmet analitiğidir; `docs/kvkk.md`).
4. **Anonimleştirme (teknik ön koşul, hukuki garanti değil):** hücre başına en
   az **10 farklı kişi** (0085'teki 5 yönetim eşiği ticari çıktıya yetmez),
   dönemde en az 100 farklı kişi, kişi başına hücre katkısı ≤ 10, kişi/gün > 300
   olay (bot) elenir, hassas kategori (`is_discoverable=false`) elenir, kişi
   sayısı banda çevrilir, "diğer" toplamı yok (çıkarma saldırısı), sütun izin
   listesi + kimlik benzeri değer reddi, ham sorgu/görsel/kimlik sütunu yok.
   Birleştirilebilir (ortak niteleyici + çakışan dönem) setlerde eşik 2×
   (`assessLinkageRisk`). Herhangi biri başarısızsa `anonymity_ok=false` ve
   dışa aktarım kapalı.
5. **Sürümleme:** `di_dataset_build` değişmez (UPDATE/DELETE yok); sürüm
   `<spec>+<başlangıç>_<bitiş>.b<n>`; satırlar kanonik JSON'un SHA-256'sı ile
   mühürlü; dönem tamamlanmış haftalardan oluşur (≤ 93 gün). Aynı kaynak aynı
   özeti verir (belirleyicilik testli). Rıza geri alınınca kaynak olaylar
   silinir; saklanan sürüm esastır, yeniden üretim farklı çıkabilir.
6. **Kalite raporu:** completeness, accuracy, consistency, uniqueness,
   freshness, coverage, lineage. Ölçülemeyenler `NOT_MEASURED`: olay kayıp oranı
   (istemci sıra numarası yok), üretim–kayıt gecikmesi (tek `created_at`
   kolonu; ayrı `occurred_at` istemci toplu/asenkron olay eklenirse gerekir —
   şimdi eklenmedi, yazımlar sunucuda eşzamanlı). Kategori/marka doğruluğu:
   tohumlu, tabakalı örnek → elle etiket (`di_accuracy_label`) → ≥ 30 karar
   varsa Wilson alt sınırı, yoksa `NOT_MEASURED`. İlk etiket kesindir.
7. **Dışa aktarım (`data.export`, yalnızca yönetici, taze giriş):** `data.csv`,
   `metadata.json`, `data_dictionary.json`, `quality_report.json`, `SHA256SUMS`.
   Dosya saklanmaz; sürümden belirleyici olarak yeniden üretilir ve manifest
   SHA-256'sına karşı doğrulanır. Dosya adı yalnızca sabit listeden (yol
   gezintisi imkânsız), CSV formül enjeksiyonu önlenir, ≤ 5 MB, saatte ≤ 10,
   iptal/başarısız durumları kayıtlı, kısmi çıktı yok, her red/indirme denetimde.
   **Parquet yok:** yeni bağımlılık eklenmedi.
8. **Yetkiler:** `data.read`, `data.build`, `data.export` — yalnızca yönetici.

## Reddedilen alternatifler

- **Arama sorgusu metnini veri setine koymak:** ayırt edici ve kişisel olabilir.
- **`click` tablosunu kaynak yapmak:** events.md/0049 §5 yasaklar.
- **Parquet için bağımlılık eklemek:** MVP'de değer/risk dengesi uygun değil.
- **Ayrı `occurred_at` kolonu şimdi eklemek:** yazım hep eşzamanlı; metrik
  dürüstçe `NOT_MEASURED`.
- **Dosyaları depoda saklamak:** yeniden üretilebilir; saklama yükü yok.

## Kalan engeller

Hukuki dayanak/rıza metni (kvkk.md), `DATA_INTELLIGENCE_*` bayrakları, doğruluk
etiketleme (≥ 30 karar), 100+ rızalı kullanıcı popülasyonu.
