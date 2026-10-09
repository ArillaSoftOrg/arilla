# 0082 — Yönetim Faz A0: kapsam kaydı, eksiksiz yetki matrisi, Gemini maliyet tahmini

**Tarih:** 8 Ekim 2026
**Durum:** Kabul edildi

Yönetim konsolunu "operasyonel kontrol merkezi"ne genişletmeden önceki temel.
Yetki haritası (0039), oturum kuralları (0044, 0050), denetim kaydı, rıza ve
gizlilik sınırları (0049, 0074, 0079) **değişmez**. Migration yok.

Numara notu: 0079 ana dalda (#71 sohbet geri bildirimi) ve açık
`chat-link-search` dalında; 0080 ana dalda (kota) ve açık
`chat-attachment-unified` dalında kullanılıyor. O dalların 0081'e geçmesi
beklendiği için bu karar 0082'dir.

## Karar

1. **Kapsam kaydı** (`packages/core/src/admin/coverage.ts`). Ekran değil,
   veri okumaz: her alt sistemi, sahip olduğu tabloları ve yönetimdeki durumunu
   sınıflandırır: `visible`, `data_no_ui`, `unmeasured`, `external`,
   `not_applicable` (gerekçeli). Ayrıca `api_usage.operation` değerleri (fiyat
   kaynağıyla), cron uçları (yazdıkları `job_run.job` ile), her yetenek
   (izle / analiz / yönet / denetim / platform; hassas mı; ayrılmış mı) ve her
   denetim hedefi. Yetenek ve denetim hedefi `Record<…>` ile derlemede
   eksiksizdir. Testler depodaki gerçek listelerle birebir karşılaştırır:
   `docs/schema.sql` + migration tabloları, TS/Python `api_usage` yazımları,
   `app/api/cron`, `vercel.json`, `withJobRun`/`track` iş adları
   (`KNOWN_JOBS`), kodda kullanılan yetenekler. Sınıflandırılmamış yeni bir şey
   eklenirse test kırılır.
2. **Yetki matrisi eksiksiz.** `authorization.integration.test.ts` her
   `page.tsx`'i (bugün 30, #71'in AI geri bildirim sayfaları dahil) ve her dışa
   açık server action'ı (bugün 18) altı
   rolle (anonim, süresi dolmuş, user, creator, moderatör, yönetici) arayüzü
   atlayarak çağırır. Reddedilen ve "zararsız" (doğrulama/bulunamadı ile dönen)
   çağrılarda veri ve mutasyon denetimi değişmez. Dosya sistemindeki sayfa ve
   action listesi matrisle birebir olmak zorundadır.
3. **Denetim etiketleri derlemede eksiksiz.** `ACTION_LABELS`
   `Record<AdminAction, …>`, hedef etiketleri `Record<AdminTargetType, …>`
   (`format.ts`); eksik `early_access_counter` etiketi eklendi.
4. **Gemini maliyeti tahmin edilir, uydurulmaz** (`packages/core/src/llm/pricing.ts`).
   - Sürümlü kural: model, katman (ücretli standart), yürürlük aralığı, 1M
     token başına USD (girdi; çıktı **düşünme dahil**), resmi kaynak ve
     doğrulama günü. Bugün: `gemini-3.1-flash-lite@2026-10-07`, $0.25 girdi /
     $1.50 çıktı (ai.google.dev/gemini-api/docs/pricing, sayfa 2026-10-07
     güncel, 2026-10-08 doğrulandı). Dönemler çakışamaz (test).
   - Kur `LLM_COST_TRY_PER_USD` (ondalık, en çok 6 basamak) tam sayı
     TRY-mikroya çevrilir; ara hesap BigInt, yukarı yuvarlama (fiyatlanmış
     çağrı asla 0 görünmez).
   - Bilinmeyen model, kullanım bilgisi gelmeyen deneme ya da tanımsız kur →
     `cost_micros = 0` ve yönetimde "fiyatlanmamış" (0051 dili). Neden süreç
     başına bir kez loglanır; değer/içerik loglanmaz.
   - Yalnızca yeni satırlar etkilenir; geçmiş yeniden fiyatlanmaz.
   - Yönetim maliyet bölümü tutarın tahmin olduğunu ve fatura olmadığını yazar.

5. **CI** (`.github/workflows/ci.yml`). Secret okumaz; üretim ya da ücretli
   API'ye bağlanmaz. İşler: typecheck + lint (PR'ın değiştirdiği dosyalar
   kesin; tüm depo taraması ana daldaki bilinen 17 bulguyu uyarı olarak iş
   özetine yazar), birim testleri (kapsam kaydı ve fiyat kuralları dahil), web
   derlemesi ve tek kullanımlık servislerle (pgvector/pg16, redis:7, Mailpit)
   boş veritabanı → migration → `arilla_app` rolü → partition → tohum →
   bütün web entegrasyon testleri + core yönetim/sohbet/sorgu yorumu
   entegrasyon testleri. Core'un geri kalan entegrasyon testlerinde ana dalda
   12 bilinen başarısızlık (ürün/arama tohum beklentileri) olduğu için bu
   kapsamda değildir; düzeltilince eklenmelidir.

## Sınırlar

- **Tahmin ≠ fatura.** Gerçek tutar Google Cloud faturalama dökümündedir (dış
  entegrasyon, ayrı karar). Ücretsiz katman, kredi ya da indirim bilinmez.
- **Kural kimliği satıra yazılmaz** (migration gerekir). `created_at` +
  `model_version` ile kural belirlenebilir; ama kur değişikliği satırdan
  okunamaz.
- **Önbellekli girdi indirimi uygulanmaz.** Interactions API
  `total_cached_tokens` döndürür ama istemci okumuyor; açık bağlam önbelleği
  kullanılmıyor. Tahmin bu yüzden üst sınırdır.
- **Başarısız denemeler** kullanım taşımıyorsa fiyatlanmamış sayılır; sağlayıcı
  bunları faturalamıyor olabilir, ama "0" bilinmediği için yazılmaz.
- `units` toplam token. Girdi/çıktı ayrımı 0059'dan beri `input_tokens` /
  `output_tokens`'ta (çıktı = yanıt + düşünme; aynı `billableTokens`; eski
  satırlar NULL, geriye dönük doldurulmaz; kapsam kaydında `data_no_ui`).
  Sonuç ve gecikme saklanmaz (`unmeasured`).

## Faz B önkoşulları

- Kur üretimde tanımlanmalı (Vercel); tanımlanana dek Gemini maliyeti
  "Hesaplanmadı" kalır.
- #71 (0079) birleşti; yeteneği (`feedback.chat.read`), denetim hedefi
  (`chat_feedback`) ve iki sayfası kayda ve matrise eklendi — kayıt testi bunu
  derlemede istedi. Açık sohbet dalları (`chat-link-search`,
  `chat-attachment-unified`) `chat/service.ts`'e dokunuyor ve ADR numaralarını
  değiştirmeli.
- Shopify dallarındaki migration 0051 çakışması, ortamların `schema_migration`
  kayıtlarına bakılarak çözülmeli (bu karar numara değiştirmez).

## Reddedilen alternatifler

- **Okuma anında geçmişi fiyatlamak:** tarihsel satırlarda girdi/çıktı ayrımı
  yok; toplam token'ı tek fiyatla çarpmak uydurma olurdu.
- **Kuru kod sabiti yapmak:** sessizce eskir; ortam değeri açık ve denetlenir.
- **`api_usage`'a `pricing_version`/`cost_estimated` kolonu:** doğru yön ama
  migration onayı ister; Faz E telemetri kararıyla birlikte.
- **Kayıt için tablo ya da çalışma zamanı keşfi:** kod sabiti + test daha
  basit, incelemede görünür.
