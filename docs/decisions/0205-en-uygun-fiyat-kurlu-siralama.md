# 0205 — "En Uygun Fiyat" kartta gösterilen (kurla çevrilmiş) fiyata göre sıralar

**Tarih:** 15 Kasım 2026 · **Durum:** kabul edildi, yerelde (birleşmedi) · **Değiştirdiği:** karar 0202 §1
· **Bayrak:** `CHAT_UX_V2` sekmesi (varsayılan kapalı); `lowest_price` yalnız bu sekmeden istenir

## Sorun

Üretim ölçümü (15 Kas, `PROBE_SORTS=1`, 32 sorgu): 32 sorgunun 26'sında "En Uygun Fiyat" ve "En İyi
Eşleşmeler" aynı ilk 10 kümesini döndürdü. Neden: karar 0202 `lowest_price` sıralama anahtarını yalnız
TRY tekliflerden kurmuştu (`sort_price` yurt dışı tekliflerde NULL). Katalogun ~%99,96'sı AliExpress
(USD); örnekte 30.000 aktif tekliften 29.668'i USD. Anahtar hemen hemen her satırda NULL olunca sıralama
fiyata değil alaka skoruna düşüyordu. "Power bank" örneğinde 120 üründen 120'sinde eski anahtar NULL idi.
Ayrıca TRY ama sıfır fiyatlı teklif en ucuz sayılıyordu (`best_offer` TRY için `current_price > 0`
aramıyor).

## Karar

`sort_price = current_price` (kart fiyatıyla aynı sayı: TRY teklif olduğu gibi, yurt dışı teklif TCMB
`forex_selling` kuruyla, `MAX_RATE_AGE_DAYS` içindeki en yeni kurla çevrilmiş yaklaşık TL).

- **Belirsiz fiyat en ucuz sayılmaz:** kur yoksa/eskiyse `current_price` NULL, sıfır ya da negatifse
  `sort_price` NULL; ikisi de `NULLS LAST` ile sona gider.
- **Sıra:** `accessory_rank` → stokta olanlar → `sort_price` artan → kesin TRY teklifi yaklaşık çevrilmişin
  önünde → alaka skoru → id.
- Kart zaten aynı çevrilmiş tutarı "kurla" işaretiyle gösterir (karar 0132); sıralama ile gösterim artık
  aynı sayıya dayanır. `balanced`, `best_match`, `best_deal` ve metin kapısı değişmedi.

## Gerekçe ve reddedilen

- Çevrilmiş tutar yaklaşıktır, ama kullanıcı kartta zaten onu görür ve "en uygun fiyat" bu sayıya göre
  yorumlanır; yaklaşık ama tutarlı sıralama, hiç sıralamamaktan iyidir. Kur yoksa uydurulmaz.
- Reddedilen 1: yurt dışı teklifleri TRY'den ayrı kademe yapmak: katalog neredeyse tamamen yurt dışı
  olduğundan sekme yine işlevsiz kalırdı.
- Reddedilen 2: ham alt birim (USD sent) ile sıralamak: para birimleri karşılaştırılamaz.

## Sınırlar

- Kur boşluğu (örn. dokuz günlük bayram tatili): `MAX_RATE_AGE_DAYS=4` aşılırsa yurt dışı fiyatlar NULL
  olur, sekme yine alakaya düşer (yanlış sıralamadan iyi). Kur işinin sağlığı ayrıca izlenmeli.
- Fiyat sıralaması yalnız metin kapısından geçen adaylar arasındadır; kapı gevşek eşleşmelere izin
  verdiği için en ucuzlar arasında zayıf alakalı ürünler çıkabilir (örnek: "power bank" aramasında kılıf/
  yedek parça). Alaka eşiği ve ranking ölçümü (P@5/NDCG@10) bayrak açılmadan yapılmalıdır.
- Çok düşük (örn. 0,10 USD) ama gerçek fiyatlar sıralamayı etkiler; yer tutucu ilanlar ("fark
  ödemesi" gibi) için ayrı bir taban kuralı yok.

## Doğrulama

`lowest-price-converted.integration.test.ts` (kurlu yurt dışı + TRY karışık sıralama, kursuz ve sıfır
fiyat sonda, stoksuz ucuz ürün stoklunun arkasında); mevcut `text-sorts`, `search-explain`,
`foreign-offer-search`, `candidate-limit` testleri değişmeden geçer.
