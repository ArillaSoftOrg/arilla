# 0094 — Yapay zekâ ve eşleştirme altyapısı sağlamlaştırma

**Tarih:** 10 Ekim 2026 · **Durum:** kabul edildi (AI/Gemini denetimi, `feature/ai-hardening-comprehensive`)

Denetim, kanıtlanmış hataları ve ölçülemeyen riskleri ayırdı. Bu karar yalnızca
**kanıtlananları** düzeltir; mimari (TS ↔ Python yalnızca PostgreSQL/Redis,
model çıktısı yalnızca niyet) değişmez.

## Karar

### Eşleştirme (`services/ingest/resolve`)

- Hacim miktarında yalnızca ondalık kısımdaki sıfırlar atılır (`100 ml` ≠ `10 ml`).
- Tek haneli sayılar atılmaz. Model numarası, kapasite (GB/TB), ekran boyutu ve paket
  adedi **sayısal kimlik**tir: iki taraf da kendine özgü bir sayı taşıyorsa veto.
  Bir tarafta fazladan sayı eksikliktir, veto değildir.
- `256 GB` / `256GB`, `V2` / `Gen 2` / `2. Nesil`, `AB-1234` / `AB1234` aynı token olur.
- GTIN yalnızca GS1 kontrol basamağı doğruysa ve placeholder değilse, MPN yalnızca
  anlamlıysa kesin kimliktir (`resolve/identity.py`).
- Renk çıkarımı marka adını ve ürün adı olan sözcükleri (`Kahve Makinesi`) renk saymaz;
  bitişik renk zinciri sıradan bağımsızdır.
- Görsel aday kanalı önce vektöre en yakın teklifleri seçer, sonra ürün başına teke indirir.
- **Eşikler değişmedi** (0,63 / 0,84). Genişletilmiş regresyon setiyle ölçüm eşiklerin hâlâ
  geçerli olduğunu gösterdi (eşleşme min 0,747; eşleşmeme max 0,580).

### Fiyat ve para birimi

- Fiyat yüzdeliği yetersiz geçmişte (az gözlem, kısa süre, hiç fiyat değişimi yok) `NULL`.
- Link sayfası fiyatı metnin kendisinden ayrıştırılır; belirsiz (`1,299`), sıfır, negatif ve
  10.000.000 TL üstü reddedilir. Varsayılan besleme biçimi bildirilen ayraçlara uymayan
  metni sessizce yanlış okumaz, reddeder.
- Para birimi uydurulmaz ve **hiçbir kaynak türünde TRY dışı teklif yazılmaz** (CLAUDE.md: para birimi TRY).
- Fiyat filtresi kartta gösterilen en iyi teklife bakar; pasif mağazanın teklifi hiçbir
  yüzeyde görünmez.

### Gemini, kota ve muhasebe

- Sohbet `api_usage` satırları yanıt yazımından bağımsız yazılır (kural 9).
- Anlık yorum: aynı kimlik için tek uçuş (Redis `SET NX`, açık kalır); kayıt bir kez yeniden denenir.
- Sohbet oluşturma aynı `requestKey` için advisory kilit altında idempotent; metin-yalnız
  yollarda örtük anahtar vardır.
- Model çağıran tur kullanıcı başına sınırlıdır (`turn:<id>` sayacı, saatte 3 × mesaj tavanı);
  aşılırsa deterministik yedek, Gemini çağrısı yok. Görsel çözme de çözmeden önce sayılır.
- Model fiyatı yalnızca açık fiyat kalıbı, tutar işaretine bitişik sayı ya da bütçe sorusunun
  cevabıyla temellenir (`iPhone 15` → 15 TL olmaz).

### Worker

- `embed_texts` parti başına commit eder, art arda hatada durur. Kalıcı reddedilen görsel
  partiyi böler. Bozuk JSON gövdesi `EmbeddingError`dır.
- Eşleştirme kosusu teklif başına savepoint kullanır ve tek koşu advisory kilidi alır.
- Kanonik metni değişen teklifin metin vektörü silinir (fiyat/gürültü eki silmez).

### KVKK

- Kullanıcı verisi dışa aktarımı sohbet görsellerini (bayt + saklanan özet) içerir.

## Reddedilen / uygulanmayan

- **Anlık yorum isteminin değiştirilmesi**: istem `taxonomyHash`in parçasıdır; değişirse tüm
  saklanan yorumlar geçersiz olur ve yeniden ödenir. Çıktı enum-only şema ve "bütçe metinde
  geçmeli" doğrulamasıyla zaten sınırlı; gösterilmiş bir açık yok.
- **Hibrit skoru üretim akışına bağlamak**: `combine` üretimde vektörsüz çağrılıyor (doğrulandı).
  Bağlamak skor dağılımını değiştirir; kalibrasyon ve gerçek veriyle ölçüm gerekir.
- **HNSW `ef_search` / `iterative_scan`**: küçük ölçekte planlayıcı HNSW seçmediği için sorun
  yeniden üretilemedi. Zararsız, işlem-yerel ayar yalnızca toplu işlere eklendi; üretim
  ölçeğinde `EXPLAIN (ANALYZE)` ile doğrulanmalı.
- **`/ara/gorsel` benzerlik tabanı**: sayfa 0091 ile kalktı; backend'in tek çağıranı link
  araması ve o zaten 0,72 tabanını uyguluyor.

## Migration

Gerekmedi. Tüm değişiklikler kod ve test.
