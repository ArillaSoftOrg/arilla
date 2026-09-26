# 0032 — Shopify aktivasyon hazırlığı doğrulaması

**Tarih:** 2026-09
**Durum:** kabul edildi (kod ve çevrimdışı testler hazır; canlı koşu ayrı,
onaylı bir adım olarak yapılmadı)

## Karar

`0021` ile para birimi doğrulanan 18 Shopify merchant'ı için aktivasyondan
önce eksik kalan kanıt salt okunur bir komutla toplanır:
`python -m collect.verify_readiness [--merchant <slug>] [--report <yol>]`.

- **Aday:** yalnızca `currency = "TRY"` ve `currency_verified = true`
  (kapıyla aynı kural, `0031`). Diğerleri istek atılmadan dışarıda kalır.
- **Önce robots, merchant başına en fazla iki istek:** `/robots.txt`, ve
  yalnızca o izin verirse `/products.json?limit=5&page=1`. İkinci sayfa yok,
  yeniden deneme yok, yönlendirme izlenmez, saniyede en fazla 1 istek
  (`Crawl-delay` daha uzunsa o), 10 sn zaman aşımı, `ArillaBot` user-agent'ı.
- **robots yorumu repo ile aynı** (`urllib.robotparser`, 404 = kural yok,
  401/403 = yasak — `collect/link/robots.py`), ama aktivasyon kanıtı için
  daha katı: 3xx, 5xx, ağ hatası ve okunamayan yanıt FAIL'dir (kullanıcı
  linki yolunda bunlar izin sayılıyordu). Standart kütüphane `*`/`$` joker
  karakterlerini anlamadığı için bizim gruba uygulanan ve hedef yolla eşleşen
  joker bir `Disallow` FAIL sayılır — yanlış bir PASS'tan kaçınılır.
- **Örnek veritabanına yazılmaz:** mevcut Shopify connector'u ve
  `normalize()` örnek üzerinde bellekte, ağsız çalışır.
- **Seçenek eşlemesi** bootstrap manifestinin ad listeleriyle
  (`color_option_names`, `size_option_names`, `0027`) sınıflanır ve mevcut
  yapılandırmayla karşılaştırılır. Kanıt yetersizse UNKNOWN, mevcut eşleme
  örnekle çelişiyorsa FAIL; tahmin yapılmaz.
- **Karar:** READY (tüm kanıt olumlu), NOT_READY (en az bir olumsuz kanıt),
  REVIEW (olumsuz yok ama yetersiz). READY bile aktivasyon değildir;
  aktivasyon onaylı rapora dayanan ayrı bir migration'dır.

## Gerekçe

Aktivasyon hazırlık denetimi (0018–0021 sonrası) şunları buldu: `/products`
için robots kanıtı 18 mağazanın hiçbirinde yok; `/products.json` için
mağaza başına güncel kanıt yok; 0018'in konumsal eşlemesi (`option1` renk,
`option2` beden) `0027`'nin bulgusuna göre casadora-baby ve for-fun için
yanlış, diğer 16 için bilinmiyor. Bu komut her birini tek istekle ve
yazmadan kanıtlar.

## Reddedilen alternatifler

- **`RobotsCache`'i olduğu gibi kullanmak.** Kullanıcı linki için ağ
  hatasında ve 5xx'te izin verir, yönlendirmeyi izler; aktivasyon kanıtı
  için fazla gevşek.
- **Joker karakterli robots kuralları için ikinci bir tam yorumlayıcı
  yazmak.** Repo'nun yorumundan ayrışırdı; yalnızca muhafazakâr bir
  "belirlenemez = FAIL" koruması eklendi.
- **Örnekte renk/beden yoksa eşlemeyi PASS saymak.** 5 ürün tüm kataloğu
  temsil etmez; UNKNOWN → REVIEW.
