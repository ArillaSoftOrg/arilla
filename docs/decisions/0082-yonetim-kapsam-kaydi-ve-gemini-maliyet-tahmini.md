# 0082 — Yönetim Faz A0: kapsam kaydı, eksiksiz yetki matrisi, Gemini maliyet tahmini

**Tarih:** 8 Ekim 2026
**Durum:** Kabul edildi

Yönetim konsolunu "operasyonel kontrol merkezi"ne genişletmeden önceki temel.
Yetki haritası (0039), oturum kuralları (0044, 0050), denetim kaydı, rıza ve
gizlilik sınırları (0049, 0074, 0079) **değişmez**. Migration yok.

Numara notu: 0079 açık iki dalda (#71 sohbet geri bildirimi, sohbette ürün
linki), 0080 ana dalda (kota) ve `chat-attachment-unified` dalında kullanılıyor;
o dalın 0081'e geçmesi beklendiği için bu karar 0082'dir.

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
   `page.tsx`'i (bugün 28) ve her dışa açık server action'ı (bugün 18) altı
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
- `units` hâlâ toplam token; girdi/çıktı ayrımı, sonuç ve gecikme saklanmaz
  (kapsam kaydında `unmeasured`).

## Faz B önkoşulları

- Kur üretimde tanımlanmalı (Vercel); tanımlanana dek Gemini maliyeti
  "Hesaplanmadı" kalır.
- PR #71 (0079, `feedback.chat.read`) ve sohbet dallarının sırası
  netleşmeli: aynı dosyalar (`admin-nav.ts`, `capabilities.ts`, `audit.ts`,
  `format.ts`, `chat/service.ts`). #71 birleşince yeni sayfa ve action bu
  matrise ve kayda eklenmelidir (testler bunu zorlar).
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
