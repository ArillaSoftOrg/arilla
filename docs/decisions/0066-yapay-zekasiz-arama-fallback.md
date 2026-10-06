# 0066 - Yapay zekasız arama fallback'i

## Karar

`/ara` metin aramasında birebir eşleşme yoksa kullanıcıya yalnızca "sonuç yok"
demek yerine **güvenilir yakın sonuçlar** gösterilir, gerçek sonuçtan açıkça
ayrılmış biçimde. Tüm mekanizma model/LLM çağrısı olmadan çalışır (kural 1).

- **Orkestrasyon** `packages/core/src/search/fallback/`: `searchWithFallback`
  mevcut ayrıştırıcının `QueryObject`'ini sağlayıcıdan bağımsız bir
  `SearchQuery`'ye çevirir, `SearchProvider` arayüzünden çağırır, adayları
  `gradeItem` ile doğrular ve sıralar.
- **Sağlayıcı arayüzü** `SearchProvider.search(SearchQuery) -> ProviderPage`.
  Bugün `createPostgresSearchProvider` (mevcut `search()`); PostgreSQL'e özgü
  her şey (SQL, GUC, trigram eşiği) yalnızca orada. OpenSearch'e geçişte yalnız
  yeni bir sağlayıcı yazılır.
- **Adımlar** (erken çıkışlı; gerçek eşleşme bulunan ilk adımda durur):
  `exact` → `alias` → `fuzzy` → `variant_relaxed` → `family`/`head_only` →
  `constraint_relaxed` → `related`. Zero-result yolunda en fazla 10 sağlayıcı
  çağrısı.
- **Doğrulama**: SQL kapısı 3+ tokenlı sorguda bir niteleyici eksiğe izin
  verir; "iphone 17 pro max" için "iPhone 16 Pro Max" kapıdan geçerdi. Model
  kodu (sayı ve sayı içeren kod) sert kısıttır: tutmayan ürün gerçek eşleşme
  sayılmaz. Model kodu içermeyen sorgularda mevcut davranış aynen korunur.
- **Gevşetme sırası**: sağdan sürüm eki (`max`, `pro`), model kodu, renk, beden,
  kategori (üst kategoriye; kök kategoriye asla). Fiyat aralığı, marka hariç
  tutma, stok ve mağaza kısıtı hiçbir adımda gevşetilmez. Marka/kategori
  tamamen kaldırılmaz.
- **Eşik**: puanı `MIN_RELATED_SCORE` altında kalan aday gösterilmez. Hiç aday
  geçmezse arayüz dürüstçe boş durumu gösterir; alakasız ürün göstermekten iyidir.
- **Takma adlar**: `AliasSource` arayüzü; bugün küçük tohum + `lexicon`
  `synonym` satırları. Taksonomi/marka/öğrenilmiş takma adlar aynı arayüze
  eklenir; yüzlerce sabit kelime kodda tutulmaz.
- **Gözlem**: `SearchTrace` (sorgu, normalize sorgu, aşama, mod, sonuç sayısı,
  gevşetme nedeni, gecikme). Log satırı sorgu metnini içermez.
- **Arayüz**: gerçek sonuç "N sonuç" + sekmeler; yakın sonuç ayrı bölge,
  "Aradığın ürünü bulamadık." başlığı, sayaç ve sekmeler yok. `usedFallback`
  (karar 0054) artık yalnızca yakın sonuç gösterildiğinde true.

## Ölçüm (gerçek PostgreSQL 16, yalıtılmış yerel DB)

- Entegrasyon: `fallback/postgres-provider.integration.test.ts` (17 test).
  `DATABASE_URL`/`DATABASE_URL_OWNER` yerel DB'ye verilir; kök `.env` üretimi
  gösterir ve test yalıtımı onu reddeder.
- `pg_trgm` 0001 migration'ından gelir (üretim şeması garanti eder); ek
  index/migration gerekmedi. `product_title_fold_trgm` kullanılıyor.
- Bulanık adım `set_config(..., is_local = true)` ile YALNIZCA kendi işleminde
  eşiği 0.3'e çeker; commit'te geri döner, havuzdaki bağlantıya sızmaz
  (tek bağlantılı havuzla testle doğrulandı). Eşik 0.35 iken "airpdos"
  (bitişik harf yer değişimi, trigram 0.33) kaçıyordu.
- DB sorgusu (ifade) sayısı: exact sonuçta 2 (arama + "başlangıç fiyatı");
  zero-result en çok 11 (5 adım). Bulanık adım yalnızca exact adım HİÇ aday
  getirmediğinde çalışır. Aşamalar toplam `FALLBACK_TIME_BUDGET_MS` (1500 ms)
  ile sınırlıdır.
- Bilinen ölçek sınırı (mevcut `search()` SQL'i, fallback'e özgü değil):
  `best_offer` CTE'si adaydan bağımsız TÜM `offer` tablosunu `DISTINCT ON` ile
  tarar; 300 bin üründe seçici bir terimde bile ~0.7 sn taban maliyet, sık
  geçen baş isimde (`token LATERAL` 37 bin satır) 2–4 sn. Her fallback adımı bunu
  tekrarlar. Çözüm ayrı iş: `best_offer`ı aday başına `LATERAL ... LIMIT 1`e
  çevirmek ya da ürüne en iyi teklifi önceden yazmak; 120M'de arama motoru.

## Gerekçe

Eski davranış: sonuç yoksa yalnızca filtreler silinip aynı metin kapısıyla
yeniden aranırdı; bas isim ("max") bulunmayınca bu da boş dönerdi ve kullanıcı
dead-end görürdü. Maliyet artmaz: LLM yok, gevşetme yalnızca sıfır sonuçta ve
sınırlı çağrıyla çalışır.

## Reddedilen alternatifler

- Eşiği düşürüp SQL kapısını gevşetmek: yanlış pozitifi artırır (karar 0029'un
  "hali" ~ "halkalı" tuzağı).
- Boş sonuçta modele sormak: kural 1 ve maliyet.
- Ayrı arama motoru şimdi eklemek: kural (pgvector/PostgreSQL yeterli); yalnızca
  arayüz hazır tutuldu.
