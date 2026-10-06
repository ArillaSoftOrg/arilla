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
