# 0104 - Merkezi, kullanıcı dostu hata yönetimi

## Karar

Hatalar `packages/core/src/errors` altında tek katalogda sınıflanır
(`@arilla/core/errors`, istemcide de çalışır, bağımlılığı yok):

- `ErrorCode`: `db_capacity`, `db_unavailable`, `cache_unavailable`,
  `deployment_mismatch`, `ai_rate_limited`, `ai_timeout`, `ai_unavailable`,
  `ai_bad_response`, `web_search_unavailable`, `request_timeout`, `rate_limited`,
  `network`, `session_expired`, `invalid_image`, `invalid_link`, `no_results`,
  `unknown`.
- Her kodun Türkçe başlığı, açıklaması, eylemi (`retry` / `reload` / `login` /
  `none`), yeniden denenebilirliği ve kapsamı katalogdadır.
- `classifyError` yalnızca kanıta dayanır: `EMAXCONNSESSION`/`53300`, sürücü
  bağlantı kodları, `LlmError.code`, `RedisUnavailableError`, "Failed to find
  Server Action" ve chunk hataları, `AbortError`. İşaret yoksa `unknown`; neden
  uydurulmaz. Ağ hatası yalnızca istemcide sınıflanır.
- `reportError` sınıflar, `ARL-XXXXXXXX` referansı üretir ve tek satır JSON
  loglar (kod, hata adı, sürücü kodu, adres/anahtar silinmiş kısa metin). Kullanıcı
  girdisi, URL, SQL parametresi, yığın loglanmaz.
- Sunucu eylemleri yalnızca `{code, reference}` döner. Yakalanmamış sunucu
  hataları `instrumentation.ts` `onRequestError` ile sınıflanır; Next `digest`'i
  referans olur (ekrandaki kod ile log satırı eşleşir; yalnızca rota kalıbı yazılır).
- Arayüz: `ErrorNotice` (`packages/ui`) + `ErrorView` (`apps/web`). Kapsama göre
  satır içi / bölüm / sınır: sohbet hatası sohbetin içinde (geçmiş ve taslak
  yerinde), internet araması hatası yalnızca kendi bölümünde (katalog sonuçları
  kalır), ürün kaydetme hatası düğmenin altında. Tam sayfa ekran yalnızca
  `error.tsx` / `global-error.tsx` sınırlarında.

## Gerekçe

Tek "bir hata oluştu" metni hem kullanıcıyı çaresiz bırakıyor hem de destekte
neden bulmayı zorlaştırıyordu. Neden sunucuda belirlenirse kullanıcı doğru
eylemi (tekrar dene, sayfayı yenile, yeniden giriş) görür; referans kodu ile
ekip ilgili log satırını bulur. Üretimde Next sunucu hata metnini istemciye
göndermediği için sınır bileşenleri nedeni çoğunlukla bilemez - bu durumda
`unknown` + referans gösterilir.

## Reddedilen alternatifler

- Hata metnini istemciye taşıyıp orada eşlemek: sızıntı riski (SQL, adres).
- Üçüncü taraf hata izleme servisi: yeni bağımlılık ve veri aktarımı (KVKK).
- Bilinmeyen hatayı "en yakın" koda eşlemek: yanlış açıklama; bilinmeyen
  `unknown` kalır.
- Toast kütüphanesi: ihtiyaç satır içi ve bölüm hatalarıyla karşılandı.
