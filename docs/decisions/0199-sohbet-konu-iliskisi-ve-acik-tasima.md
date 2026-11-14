# 0199 — Sohbette konu ilişkisi (`relation`) ve açık taşıma (`carry`)

**Tarih:** 15 Kasım 2026 · **Durum:** kabul edildi · **Genişletir:** 0074 ("Yama anlamları")

## Sorun

Karar 0074 yalnızca iki durum tanır: `reset` (bağımsız yeni konu, her şey atılır) ve
reset'siz yama (daraltma; kategori değişirse yalnız beden/nitelik silinir, marka, renk, fiyat
"kullanıcının tercihi" olarak kalır). `hardening.test.ts` bu davranışı korur ("Nike ayakkabı →
mont"da Nike, siyah ve 2.500 TL kalır).

Üçüncü bir durum tanımsızdı: **ilişkili yeni arama**. Model `reset` unutursa "Samsung telefon,
15.000 TL → masa lambası"nda marka ve bütçe lambaya taşınır; model `reset` verirse "aynı bütçeyle
mont" gibi bilinçli sürdürme kaybolur. Kodda konunun değiştiğini anlayacak bir işaret yoktu ve
sözcük örtüşmesi ya da elle yazılmış kategori sözlüğü bu ayrımı güvenilir yapamaz.

## Karar

1. Model yamasına iki **isteğe bağlı** alan eklenir (şema ve doğrulayıcı birlikte):
   - `relation`: `refine` | `new_independent` | `new_related`.
   - `carry`: yalnız `new_related` için, önceki niyetten taşınacak alanlar (`brand`,
     `excludeBrands`, `colors`, `size`, `priceMin`, `priceMax`, `attributes`, `sort`; kategori ve
     sorgu hiçbir zaman taşınmaz).
2. Birleştirme (`mergeSearchIntent`):
   - `new_independent`: önceki niyet atılır (`reset` ile aynı).
   - `new_related`: önceki niyet atılır, yalnız `carry` alanları kopyalanır, ardından yamadaki
     yeni değerler üstüne yazılır (**açık yeni değer eski değerden önceliklidir**).
   - `refine`: 0074 davranışı.
3. **Geriye uyumluluk:** `relation` yoksa 0074 aynen geçerlidir (`reset` = bağımsız, aksi halde
   daraltma; kategori değişimi yalnız beden/nitelik siler). Geçersiz `relation`/`carry` yamayı
   reddetmez, yok sayılır. Yedek (modelsiz) yol bu davranışı korur.
4. **Sunucu doğrulaması (`groundPatch`):** model `carry` önerir, tek başına yeterli değildir. Bir
   alan yalnız (a) mevcut niyette doluysa ve (b) kullanıcı ifadesi onu açıkça sürdürüyorsa taşınır:
   "aynı bütçe/fiyat", "aynı marka", "aynı renk/beden", niyetteki marka/renk/beden/nitelik
   değerinin metinde anılması, "daha uygun fiyatlı" (sıralama) ya da "aynı filtrelerle". Seçenek
   cevabı için `carry_filters` değeri tüm dolu alanları destekler. `new_related` dışında `carry`
   atılır; önceki niyet yoksa `new_related` bağımsız arama gibi işlenir.
5. **Belirsizlik için mevcut `clarify` mekanizması** (yeni bekleyen-soru altyapısı yok): kural
   model istemindedir; yalnız yanlış taşımanın sonuçları anlamlı biçimde değiştireceği durumda
   (önceki niyette marka/bütçe/renk varken ürün türü değişiyor ve kullanıcı metni açık değil)
   tek soru (`id = carry_filters`; seçenekler `carry_filters` / `fresh_search`). Her kategori
   değişiminde sorulmaz; art arda 2 soru sınırı (0074) geçerlidir. Modelsiz yolda bu cevaplar
   sorgu olarak etiketi eklemek yerine, sorunun sorulmasına yol açan önceki kullanıcı mesajını arar
   (`carry_filters` → `new_related` + dolu alanlar, `fresh_search` → `new_independent`).
6. **Ürün referansı ve uyumluluk:** "iPhone 15 → buna uygun şarj cihazı"nda referans sorgu
   metninde kalır ("iphone 15 şarj cihazı"); telefonun marka/beden/kapasite/bütçe filtreleri
   taşınmaz. Katalogda uyumluluğu doğrulayan veri yoktur; model "uyumlu/tam uyar" gibi kesin iddia
   kurmaz (istemde yasak). Sonuçlar yalnız ürün adıyla arama sonucudur.
7. **Önceki konuya dönüş:** `previousTopicIntents`, konuşmanın önceki konularındaki son niyetleri
   (en çok 3, aynı konunun sürümleri teke indirilmiş) modele `previous_intents` olarak bağlam verir.
   Hiçbir filtre bundan otomatik uygulanmaz; model açık yama döndürür. Sözcük örtüşmesi burada
   yalnız sürümleri teke indirmek içindir, filtre kararı vermez.

## Karar önceliği

Açık kullanıcı ifadesi (yamadaki yeni değerler, "aynı bütçe") > doğrulanmış takip/konu ilişkisi
(`relation`, `carry`) > kategori/alan yakınlığı (kullanılmaz) > varsayılan davranış (0074).

## Reddedilen

- **Sözcük örtüşmesiyle otomatik konu değişimi:** ayakkabı→mont ile telefon→lamba ikisi de örtüşmez;
  0074'ün testli davranışını sessizce bozar.
- **Elle bakımlı alan/kategori sözlüğü:** bakım yükü, kapsam dışı sözcüklerde sessiz yanlış.
- **Sunucunun soru üretmesi/yeni bekleyen-soru alanı:** yama saklama gerektirir; mevcut `clarify`
  yeterli.
- **0074'ü ya da `hardening.test.ts`'i değiştirmek:** davranış `relation` yokken korunur;
  yeni sözleşme ayrı testlerle (`relation.test.ts`) doğrulanır.

## Sonuç ve sınırlar

- Veri/şema değişikliği yoktur: yama saklanmaz, yalnız birleşmiş niyet saklanır.
- Gerçek model çıktısında `relation` kalitesi ölçülmedi; ücretli Gemini değerlendirmesi ayrı onayla
  yapılır. Model alanı vermezse davranış 0074'tür (eski hata yüzeyi sürer).
- **Yedek (modelsiz) yol:** merkezi kategori sözlüğü (karar 0133, `parseQueryText`) iki taraf için
  de KESİN bir kategori yoluna çözülüyor ve ana alan (yolun ilk parçası) farklıysa bağımsız yeni
  arama sayılır ("samsung telefon" → "masa lambası"). Çözülemeyen ("256 gb", "şarjlı"), aynı alan
  ("ayakkabı" → "mont") ya da sözlüksüz durumda tahmin edilmez; 0074 daraltması sürer. Yeni sözlük
  yoktur.
- **"Bu aramaya dön"** (`restoreSearch`): eski bir arama mesajının SAKLI niyeti yeni bir tur olarak
  yeniden aranır. Eski mesajlar değişmez; yeni kullanıcı + asistan mesajı eklenir,
  `current_search_intent` o niyete döner. Niyet istemciden gelmez; sahiplik `user_id` ile satır
  kilidi altında, `seq` ardışık, tekrar tıklama `client_request_id` ile tekilleştirilir, aynı niyet
  zaten geçerliyse tur açılmaz. Model çağrılmaz; kota bir kullanıcı mesajı kadardır.
