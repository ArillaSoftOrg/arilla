# 0205 — Fallback adımı sorgu bütçesi (lexical zaman aşımı)

Tarih: 15 Kasım 2026. Bağlı: 0129 (aday kümesi), 0066 (fallback), 0190/0196 (anlamsal sunum).

## Sorun

"Kadın dolgu topuk terlik" sohbet aramasında "sonuç yok": `searchByIntent` tüm fallback'i TEK işlemde
`statement_timeout = 4 sn` ile çalıştırır; adımlardan biri aşılınca işlem iptal olur, hata yukarı çıkar,
`serveSemantic` (BGE-M3) hiç çağrılmaz.

## Doğrulanan kök neden (yerel ölçüm)

Gerçek `query_resolution` kaydındaki dört slotla (üretimden salt okunur çekildi) 3,95 M yurt dışı satırlı
(160 k gerçek başlık x 25, iki kısmi GIN dahil) yerel kopyada:

- `exact` adımı: 0,26 sn, 0 sonuç (güvenli; dolgu/topuk İngilizce başlıkta yok).
- `fuzzy` adımı: 3,2 sn. Dal başına `kelime <<% baslik` (eşik 0,3) GIN'den 72 bin aday döndürür, hiçbiri
  geçmez; `LIMIT` hiç dolmadığı için TÜM adaylar tek tek `strict_word_similarity` ile yeniden denetlenir
  (~16 us/satır = 1,2 sn/dal; regex, JOIN ve teklif doğrulaması süreyi DEĞİŞTİRMEZ: yalnız `<<%` ile 1,19 sn,
  tam sorguyla 1,19 sn). Süre satır sayısıyla doğrusal: 13,7 M satırda dal başına ≈ 4 sn.
- Eşleşmesi olmayan her uzun kelime (burada eş anlamlı "kadinlar") bu maliyeti yaratır; yalnız kullanıcının
  yazdığı kelimelere inmek ("typed") durumu 7,4 sn'ye KÖTÜLEŞTİRDİ (dolgu/topuk daha geniş aday verir).
  Yani sorun belirli bir kelime değil, eşleşmesiz bulanık dalın sınırsız yeniden denetimi.

## Karar

Her fallback adımı (exact hariç) kendi savepoint'inde `statement_timeout = FALLBACK_STAGE_BUDGET_MS`
(1000 ms) ile çalışır. Aşılırsa adım atlanır (bos sayfa, iz `truncated`), sonraki adımlar ve isteğin kalanı
sürer; önceki sınır geri konur. `stageBudgetMs: 0` eski davranıştır. SQL, sıralama ve eşikler değişmedi.

Ölçüm (prod ölçeğine 1/3,5 emülasyon: dış sınır 1100 ms, bütçe 285 ms): önce işlem iptali ("sonuç yok",
1,56 sn'de hata); sonra istek 1,13 sn'de tamamlanır, bulanık adım atlanır. Yazım hatası doğruluğu aynı
(yerel 160 k: aynı adımlar, aynı sonuç sayıları).

## Bilinçli olarak yapılmayanlar (ayrı karar)

- Boş sözcüksel sonuçta anlamsal çalıştırma (`lexical_empty` atlaması): Türkçe sorgu BGE'de zayıf
  (8 sorguda P@10 proxy 19/80 TR, 74/80 İngilizce karşılık); hazır çeviri olmadan alakasız kart göstermemek
  için DEĞİŞTİRİLMEDİ.
- Bulanık adımı TRY/yurt dışı olarak ikiye bölmek, yurt dışı bulanıklığı yalnız yabancı karakterli
  token'a kısıtlamak, İngilizce sorgu terimi (IntentV2'den) — öneri olarak raporlandı.
