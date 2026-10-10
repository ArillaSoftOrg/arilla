# 0096 — AI değerlendirme ve hata veri seti

**Tarih:** 10 Ekim 2026 · **Durum:** kabul edildi (Faz 1A-2) · **Migration:** 0060
**Bağımlılık:** Faz 1A-1 (PR #85, `packages/core/src/eval/*`) — bu karar onun
çıktısını (metrik, vaka sonucu) saklar.

## Karar

Dört tablo eklenir; mevcut altyapı yeniden kurulmaz.

| Tablo | Rol | Değişmezlik |
|---|---|---|
| `dataset_snapshot` | Altın set sürümü: ad, sürüm, **içerik SHA-256**, doğrulanmış/aday sayısı, kod referansı | SELECT+INSERT |
| `ai_eval_run` | Bir ölçüm: bileşen, algoritma/model sürümü, metrikler (JSONB ≤4 KB), maliyet özeti, gecikme p50/p95, regresyon bayrağı, temel çizgi bağlantısı | SELECT+INSERT |
| `ai_eval_case` | Koşunun vaka sonucu: `case_key` (fixture metninin SHA-256 öneki), sonuç, hata sınıfı, skor | SELECT+INSERT |
| `ai_error_event` | Model çağrısı hatası: sağlayıcı × sabit hata sınıfı, HTTP durumu, gecikme, model sürümü | UPDATE yok, DELETE 180 gün saklama için |

### Yeniden kullanılanlar (yeni tablo açılmadı)

- **Maliyet:** `api_usage` kaynak doğruluktur. `ai_eval_run.cost_micros` yalnızca
  canlı (`live`) koşunun özetidir; çevrimdışı koşu `cost_micros = 0` ve
  `api_calls = 0` olmak zorundadır (CHECK). Canlı koşu çağrıları `api_usage`'a
  `eval_*` işlem adıyla yazılmalıdır.
- **İş koşusu:** `job_run` (opsiyonel FK).
- **Eşleştirme ret nedenleri:** `match_candidate.review_reason` (0028) zaten
  insan kararını tutar; `matchRejectionBreakdown` yalnızca okur.
- **Arama başarısızlıkları** (sıfır sonuç, ilgisiz sonuç) model hatası değildir:
  `ai_eval_case.failure_class` (`zero_result`, `low_rank`, ...) olarak değerlendirme
  koşusunda tutulur, `ai_error_event`'e girmez.
- **Doğru etiketler** depodaki fixture dosyalarında (git sürümlü) kalır;
  veritabanına kopyalanmaz.

### Gizlilik (kural 10, KVKK)

Ham kullanıcı sorgusu, sohbet metni, görsel, kullanıcı/oturum kimliği, istem ve
yanıt metni **hiçbir tabloda yoktur**. `case_key` geri çevrilemeyen hash'tir;
`error_summary` ≤300 karakter ve `redactJobError` ile (adres, e-posta,
`anahtar=değer` sırları) maskelenir; `detail` ≤1 KB düz JSON.

### Hata sınıfı kümesi

`timeout, rate_limited, quota, auth, bad_request, schema_invalid, safety_blocked,
empty_output, server_error, network, unknown`. `LlmError` kodları ve Jina HTTP
durumları `classifyAiError` ile bu kümeye indirilir.

## Kapsam dışı (bilinçli)

Üretimdeki Gemini/Jina çağıranlarına `recordAiError` bağlanmadı: bu, kural 1/9
altındaki istek yoluna dokunur ve ayrı bir PR'dır. Bu karar yalnızca şemayı,
yazıcıyı ve testleri getirir. Saklama temizliği (`purgeAiErrorEvents`) bir cron'a
bağlanmadı.

## Reddedilen alternatifler

- **Vakaları tabloya kopyalamak:** fixture'ın ikinci doğruluk kaynağı olur ve
  ham sorgu metni veritabanına girerdi.
- **`api_usage`'a hata/gecikme kolonları eklemek:** her model çağrısı satırını
  şişirir; ayrıca 0059 (token ayrımı) başka bir dalda bekliyor, çakışma riski.
- **Hataları `job_run.detail`'e yazmak:** koşu başına tek satır ve 4 KB; çağrı
  düzeyinde dağılım çıkmaz.
- **Güncellenebilir koşu satırı:** düzeltme yeni satırdır; geçmiş ölçüm
  sessizce değişemez.
