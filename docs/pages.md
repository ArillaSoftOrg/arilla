# Sayfalar

Her sayfada hangi bileşen, hangi sırada, hangi boş durumda ne yazacağı. Bu
dosya olmadan her ekran farklı mantıkla kurulur.

Bileşen adları `design.md` envanteriyle aynıdır. Metinler `copy.md` içindedir.

---

## `/` Ana sayfa

**Tek iş:** bir ürünü metin, fotoğraf veya bağlantıyla aramaya başlatmak.
Ürün erişimi kapalıysa mevcut Coming Soon ekranı gösterilir.

| Sıra | Bileşen | Not |
| --- | --- | --- |
| 1 | Logo ve üst çubuk | Ortak `HomeHeader`; Trendler, Keşfet, tema ve oturuma uygun hesap bağlantıları. Mobil gezinme menüde. |
| 2 | İlk ekran | Robot, tek başlık ve `SearchComposer`. Mobil ve masaüstünde ilk ekranı doldurur; aşağıdaki ürünler ilk açılışta görünmez. Klavye kendiliğinden açılmaz. Fotoğraf düğmesi özellik açıkken görünür, misafiri mevcut giriş akışına götürür. |
| 3 | Kısa yardım şeridi | İlk ekranın altında. Nasıl çalışır sayfası gerçek sohbet görüntüleriyle hazırlanacak; şimdilik bağlantısız `Yakında` durumu. |
| 4 | Örnek aramalar | Yardım şeridinden sonra, kişisel geçmişten önce. Düğme girdiyi doldurur; mobilde yatay kayar, kendiliğinden arama göndermez. |
| 5 | Alışverişe devam et | İzinli gerçek ürün geçmişi, en çok altı ürün. Misafire ve geçmiş yokken çizilmez. TL fiyatı yoksa `Fiyatı incele` yazılır; sıfır mağaza etiketi gösterilmez. |
| 6 | Şu sıralar öne çıkanlar | `#trendler`. İlk üç gerçek koleksiyon; veri yoksa örnek koleksiyon yerine kısa ve dar bir boş durum. |
| 7 | Keşfet | `#kesfet` her zaman bulunur. Önce günün gerçek `discovery_slot` ürünleri; yoksa `getHomepageProducts` ile yayımlanmış, görselli, etkin ve fiyatlı TRY teklifli katalogdan en fazla 12 ürün. Aday okuması 1000 ürünle sınırlı, günlük seçim deterministik ve kategorilere dağıtılmıştır. Ana sayfada bağlantısız demo kartlar kullanılmaz. Veri yoksa kısa boş durum gösterilir. |
| 8 | Altbilgi | Ortak `SiteFooter`; ürün, hesap, şirket, yasal bağlantılar ve sosyal hesaplar. Mobilde yeşil ManiCepte kelime işareti sığar; yüzen arama için alt boşluk korunur. |

Ana sayfada metin gönderimi, özellik ve oturuma göre mevcut sohbet veya arama
akışını kullanır. Fotoğraf eki ve kullanıcı izni aynı gönderim hattında kalır.
Ana sayfanın Keşfet bağlantıları `#kesfet` bölümüne gider. Ortak alt sayfalar
`PublicSiteShell` kabuğunu kullanır; yönetim paneli ayrı kalır.

---

## `/gizlilik`, `/kosullar`, `/cerez` — Yasal/bilgi sayfaları (Faz 6)

`LegalPageLayout` (packages/ui) paylaşılan sarmalayıcı — okuma genişliği
(`--content-width-reading`), başlık + "son güncelleme" etiketi + içerik.
Faz 8: bu sayfalar public site kabuğunu (`public-site-shell.tsx`, header +
footer) kullanır — önceden header/footer'sız, çıkmaz sokak sayfalardı.
Faz 1B: kabuk `SkipLink` → header → `<main id="icerik">` → footer yapısının
tek sahibidir; `LegalPageLayout` artık kendi `<main>`'ini üretmez (bkz.
`docs/design.md` "Kalite tabanı").

| Route | İçerik | Durum |
| --- | --- | --- |
| `/gizlilik` | Hangi veri, neden, ne kadar saklanıyor; fotoğraf yükleme davranışı; üçüncü taraflar; `/hesap` üzerinden kullanılabilen haklar | **Taslak** — veri sorumlusu tüzel kişi bilgisi yok, hukukçu onayı bekliyor (`docs/kvkk.md`) |
| `/kosullar` | Ürünün ne yaptığı/yapmadığı, fiyat-stok sorumluluğu, affiliate ilişkisi, hesap/e-posta temelli giriş, marka-görsel kullanımı notu | **Taslak** — sorumluluk sınırlaması, uygulanacak hukuk, uyuşmazlık çözümü hükümleri yok |
| `/iletisim` | Kısa açıklama + `mailto:` e-posta (Faz 8.1). Adres `apps/web/app/site-config.ts` içinde tek yerde; `/gizlilik` "Haklarınız" da oradan okur. Telefon/adres/unvan yok | **Geçici** — kurumsal e-posta alınınca yalnızca `site-config.ts` değişir |
| `/cerez` | Kullanılan 3 çerezin (`session`, `session_id`, `theme`) amacı ve süresi | Tam — kod düzeyinde doğrulandı, analitik/pazarlama çerezi yok |

`/hakkinda` ve `/sss` (docs/sitemap.md aday listesinde) henüz **yazılmadı**.
`/iletisim` Faz 8.1'de, kullanıcının onayladığı geçici public e-posta ile
eklendi; telefon/adres hâlâ yok, uydurulmadı.

---

## `/sohbet?q=` Arama sonucu (karar 0176; eski `/ara`)

| Sıra | Bileşen | Koşul |
| --- | --- | --- |
| 1 | Arama girdisi | Sorgu dolu halde |
| 2 | Netleştirme çubuğu | `needs_clarification` ise |
| 3 | Sonuç sayısı | "32 sonuç" |
| 4 | Sekmeler | Üç sekme, varsayılan "Bizim seçtiklerimiz" |
| 5 | Sonuç ızgarası | 24 sonuç, sonra sayfalama |
| 6 | Giriş modali | 3. sorgudan sonra, sonuçlar arkada kalır |

**Netleştirme sonuçları beklemez.** En olası yorumla sonuçlar hemen gösterilir,
çubuk üstte tek dokunuşluk seçenek olarak durur.

**Yükleniyor:** iskelet kart, spinner değil. Görsel aramada iskelet kartlar
sonuç gelene kadar durur.

**Boş sonuç:** birebir eşleşme yoksa kontrollü gevşetmeyle bulunan güvenilir
yakın sonuçlar, gerçek sonuçtan ayrı başlıkla ("Aradığın ürünü bulamadık.",
sayaç ve sekme yok). Eşiği geçen yakın sonuç da yoksa dürüst boş durum;
alakasız ürün gösterilmez. Bkz. `docs/decisions/0066`.

**Hata:** "Arama şu an çalışmıyor" + tekrar dene düğmesi.

---

## `/urun/<slug>` Ürün sayfası

Sıra kritik. Kullanıcı ilk ekranda karar verebilmeli.

| Sıra | Bileşen | Koşul |
| --- | --- | --- |
| 1 | Ürün görseli | Galeri, ilk görsel `primary_image_url` |
| 2 | Başlık, marka | |
| 3 | **Fiyat farkı bloğu** | En düşük teklif + varsa liste fiyatı farkı |
| 4 | Fiyat konumu cümlesi | `product_price_stats` — "Son 90 günün en düşüğü" |
| 5 | Sahte indirim notu | `list_price_inflated` ise, nötr dille |
| 6 | Beden seçici + rozet | Beden profili varsa "senin bedenin" işaretli |
| 7 | Mağaza listesi | Fiyat, kargo dahil toplam, stok, çıkış düğmesi. Yalnızca TRY teklifler |
| 7b | Yurt dışı teklifi | TRY dışı teklif (ör. AliExpress): kendi para birimi, fiyatın kaydedildiği zaman, TCMB kuru varsa yaklaşık TL; fiyat sıralamasına girmez (karar 0121). Beslemede uzun süredir görülmeyen (doğrulanamayan) teklif listelenmez; hiçbir teklif gösterilemiyorsa "Güncel fiyat doğrulanamadı" notu çıkar, fiyat ve çıkış düğmesi yoktur (karar 0156) |
| 8 | Kaydet / alarm kur | Giriş yoksa modal açılır |
| 9 | Diğer renkler | `model_key` eşleşmesi varsa |
| 10 | Alternatif şeridi | `similarity_edge`, 4-6 ürün, yatay kaydırma |
| 11 | Fiyat geçmişi | Açık bölüm, etkileşimli grafik (karar 0168); fiyat altında özet + bağlantı |
| 12 | Son güncelleme | "2 saat önce güncellendi" |

**Mağaza listesi sıralaması:** kargo dahil toplam fiyat. Komisyon oranı
sıralamaya girmez.

**Stokta yoksa:** ürün gizlenmez, "şu an stokta yok" işareti konur ve yeniden
stok alarmı önerilir.

**Tek teklif varsa:** karşılaştırma bölümü gösterilmez, doğrudan alternatiflere
geçilir. Sayfa `noindex` alır (bkz. `sitemap.md`).

---

## `/git/<clickId>` Çıkış

Sayfa değil, yönlendirme. Sırayla: `click` kaydı yazılır, affiliate deeplink
üretilir, 302 verilir.

Ara ekran gösterilmez. Affiliate bildirimi ürün sayfasında (mağaza
bağlantısının yanında) bulunur, çıkışta kullanıcıyı bekletmez; public site
altbilgisinde affiliate cümlesi yoktur, "Affiliate Açıklaması" bağlantısı
vardır (karar 0093).

`?surface=` değerleri (`click.surface`, serbest metin, veritabanı kısıtı yok):
`search`, `collection`, `alert`, `compare` (ürün sayfası mağaza listesi),
`product_primary` (Faz 1C: ürün sayfasının birincil "…'da aç" düğmesi — stokta
olan en uygun teklif), `structured_data` (JSON-LD `Offer.url`).

---

## `/kesfet`

| Sıra | Bileşen |
| --- | --- |
| 1 | Bölüm başlığı: "Bugün öne çıkanlar" |
| 2 | Masonry ızgara, `discovery_slot` |
| 3 | Bölüm başlığı: "Kullanıcıların bulduğu" (yalnızca organik kayıt varsa) |
| 4 | Organik ızgara |
| 5 | Creator koleksiyonları |

**Seçilmiş içerik "kullanıcıların bulduğu" başlığı altında gösterilmez.**
Organik bölüm, organik kayıt yoksa hiç render edilmez.

---

## `/firsatlar`

Fiyatı düşen ürünler, günlük üretilir. Her kartta düşüş tutarı ve yüzdesi.
`list_price_inflated` işaretli ürünler bu listeden düşürülür.

---

## `/trendler` ve `/trendler/<slug>` (karar 0077)

Editoryal **ürün keşfi koleksiyonları**; blog değil. `trend` + `trend_product`
tablolarından okunur, ürün bağlarını `services/ingest/curate` toplu işi yazar.

`/trendler`: kesitler (Öne Çıkanlar, Şu An Trend, Moda, Güzellik, Ev & Yaşam,
Öğrenci, Sezonluk) kesit başına en çok 3 (öne çıkanlar 6) kart gösterir, aynı trend
ikinci kez görünmez; hepsi kapalı `Tüm Trendler` bölümündedir. Kart: 16:9 kapak,
başlık, en çok 2 satır açıklama, 4 küçük ürün önizlemesi, `+N ürün`, veri varsa
"X TL'den başlayan"; tüm kart tek bağlantı. Telefon 1, tablet 2, masaüstü 3 sütun.

`/trendler/<slug>`: `← Trendler`, kapak, başlık, tek cümle açıklama, ürün sayısı,
hemen ardından `ProductCard` ızgarası (telefon 2, tablet 3, masaüstü 4 sütun). Makale,
SEO paragrafı ve `Article` verisi yok. Geçersiz/yayında olmayan/`MIN_PUBLIC_TREND_PRODUCTS`
altı trend 404. Kapak: `hero_image_url` → temsilci ürün görseli → yer tutucu.

---

## `/trend` ve `/trend/<slug>` (ertelendi; dönemlik `trend_snapshot`)

Liste sayfası tüm yayınlanmış `trend_snapshot` kayıtlarını gösterir. Detay
sayfası kapak, başlık, açıklama ve ürün ızgarası içerir.

Sponsorlu liste **rozetli** gösterilir ve organik listelerin arasına
karıştırılmaz, ayrı bir konumda durur.

---

## `/@<handle>` Creator vitrini

| Sıra | Bileşen |
| --- | --- |
| 1 | Creator başlığı: avatar, isim, bio, takip düğmesi |
| 2 | Koleksiyon sekmeleri |
| 3 | Ürün ızgarası |

Her kartta "daha uygununu bul" eylemi görünür. Ürünün en özgün fikri bu.

**Boş durum:** creator henüz ürün eklemediyse, ziyaretçiye "bu vitrin
hazırlanıyor" denir; creator kendisi bakıyorsa ilk koleksiyonu oluşturma
yönlendirmesi gösterilir.

---

## `/kaydettiklerim`, `/alarmlar`, `/gecmis`

Üçü de aynı kalıp: başlık, liste, boş durum.

Üçü ve `/hesap` public site kabuğunu (header, menü paneli, footer) kullanır;
oturum kapısı sayfanın kendisindedir (`requireProductUser` / `requireUser`).
`/kaydettiklerim`: Başlık
"Kaydettiklerim" ve yanında soluk ürün sayısı ("3 ürün"). Ortalanmış, en fazla
4 sütunluk ızgara (1440px'te ~275px kart; 768px'te 3, telefonda 2 sütun); tek
kayıtlı ürün normal kart boyunda kalır. Kart ortak `ProductCard`: görsel, ad,
fiyat, mağaza sayısı; kartın tamamı ürün sayfasına gider. Kaydı kaldırma,
görselin sağ üst köşesindeki dolu kalp düğmesidir (bağlantının kardeşi,
tıklaması gezinmez; erişilebilir adı "Kaydettiklerimden kaldır: {ürün}"); ayrı
"Kaldır" düğmesi yoktur. Boş durum: "Henüz kaydettiğin ürün yok." + kısa metin
+ "Keşfet" (`/kesfet`).

`/gecmis` sayfasında **silme düğmesi zorunludur** ve gerçekten silmelidir.

`/alarmlar` üç alarm türünü tek listede gösterir; tür rozetle ayrılır.

---

## `/hesap`

Karar 0060: sade profil sayfası. Tema, İzinler ve Verilerim bölümleri yoktur.

| Bölüm | İçerik |
| --- | --- |
| Profil kartı | Avatar, ad, e-posta, "Yeni arama" (`/sohbet`), "Yönet" menüsü (Hesabı sil, Çıkış yap) |
| Arkadaşlarınıza tavsiye edin | "Yönlendirme bağlantınız" kartı: okunabilir davet linki (`manicepte.com/davet/YS-49577`), "Panoya kopyala" (sonra onay işareti). Ödül metni ve sayaç yok (0067) |
| Son baktıkların | `product_view` (`browsing_history` rızasıyla ürün sayfasında yazılır, ürün başına tek satır, en yeni başta); boşsa boş durum |

Gizlilik tercihleri (geri çekme) `/hesap/gizlilik` sayfasındadır. Tema yalnızca sistem tercihidir. Haftalık özet tercihi onboarding anketinin (0058)
son adımındadır, varsayılan kapalı. Silme akışı gerçekten çalışmalıdır. Onay adımı vardır ama geri alınamaz olduğu
açıkça yazılır.

---

## `/giris`

Tek alan: e-posta. Gönderim sonrası "bağlantı gönderildi" ekranı.

Aynı e-postaya arka arkaya istek oran sınırına takılır ve kullanıcıya
"birazdan tekrar dene" denir. Hesabın var olup olmadığı **belli edilmez** —
her iki durumda aynı mesaj gösterilir.

---

## `/yonetim` (kabuk ve genel bakış)

Tek iç uygulama (docs/decisions/0039). Masaüstü öncelikli yan menü; dar
ekranda menü üste taşınır. Kabuk `<main id="icerik">`'i taşır, alt sayfalar
ikinci bir `<main>` üretmez. Menü rolün yeteneklerine göre süzülür — bu
yalnızca görünümdür, her sayfa ve action yetkiyi sunucuda ayrıca ister.
`noindex`.

| Sıra | Bileşen |
| --- | --- |
| 1 | Kuyruk ve katalog kutucukları: bekleyen eşleştirme (500 üstü uyarı, ops.md), eşleşmemiş aktif teklif, aktif/toplam mağaza, 7 günde yeni kullanıcı |
| 2 | Akış kutucukları: 24 saatte veri toplama koşuları, 7 günde link araması ve görsel yükleme (duruma göre), model maliyeti (24 saat / 7 gün) |
| 3 | Son koşusu başarısız ya da kısmi biten mağazalar |
| 4 | Araç bağlantıları |

Arama sayısı ve sonuçsuz arama oranı **gösterilmez**: arama günlüğü yok,
tahmini sayı konmaz.

## `/yonetim/denetim`

`admin_audit_event`'in salt okunur listesi, yalnızca yönetici. Yeniden
eskiye, eylem filtresi, `id` imleciyle sayfalama (COUNT yok). Önce/sonra
değerleri düz metin gösterilir.

---

## `/yonetim/magazalar`, `/yonetim/ingest`

Mağaza listesi: kaynak, durum, para birimi kapısı (salt okunur kanıt),
aktif/toplam/eşleşmemiş teklif, son koşu, son başarılı koşu, son başarıdan
beri hata sayısı. Ayrıntıda izinli `feed_config` alanları (değerleri yalnızca
`currency`, `currency_verified`, `category_hint`, `bootstrap_source`; diğer
anahtarların yalnızca adı), sorgu dizisiz feed adresi ve koşu geçmişi.
Yönetici veri toplamayı açıp kapatabilir: gerekçe + kısa adı yazarak onay +
taze oturum (12 saat); denetime yazılır. "Şimdi çalıştır" yok.

## `/yonetim/katalog/*`

Ürün arama: sayı → kimlik, 8–14 hane → GTIN (ürün ya da varyant), diğer →
katlanmış başlık (trigram indeksi). Kalite kutucukları: markasız,
kategorisiz, görselsiz, teklifsiz, fiyatsız, fiyatı bayat. Ayrıntı: teklifler
(sorgu dizisiz adres), varyant SKU/GTIN ve kaynağı, eşleştirme adayları,
benzerlik kenarları, fiyat istatistiği, eski adresler. Teklifler: eşleşmemiş,
pasif, bayat. Hepsi salt okunur.

## `/yonetim/arama/*`, `/yonetim/seo`

Arama tanısı bir sorgunun normalleştirmesini, önbellek durumunu (bayat mı),
sözlük eşleşmelerini, netleştirme planını, aramaya giden sorgu nesnesini ve
ilk 20 sonucu skorlarıyla gösterir; önbelleğe/sayaca/analitiğe yazmaz. Link
araması: 7 günlük özet + istek bazında durum, hata kodu, süre, izinli sayfa
sinyalleri. Görsel arama: durum, saklama süresi, KVKK gecikmesi. SEO: katalog
eksikleri, sitemap parça uygunluğu, eski adres çakışmaları.

## `/yonetim/islemler`, `/yonetim/kullanicilar`

İşletim (yalnızca yönetici): partition kapsamı ve default doluluğu, işlerin
son kanıtı, KVKK temizlik gecikmesi, 14 günlük model maliyeti, istenince yetim
taraması. Kullanıcılar (yalnızca yönetici): tam eşleşmeyle bul, maskeli
ayrıntı; arama ve görüntüleme denetime yazılır. Rol düzenleme, silme,
kimliğe bürünme yok.

---

## `/yonetim/eslestirme`

| Sıra | Bileşen |
| --- | --- |
| 1 | Kuyruk sayacı |
| 2 | İki ürün yan yana: görsel, başlık, marka, öznitelikler, skor |
| 3 | Onayla / reddet / atla |
| 4 | Klavye kısayolları |

Kuyruk skora göre sıralanır, en belirsizler önce gelir. Klavye kısayolu şart:
bu ekran günde yüzlerce kez kullanılacak.

Kuyruk sayacı sayfadaki grubu değil gerçek toplamı gösterir. Yöntem ve mağaza
filtresi; kartta fiyat, stok, GTIN/MPN, varyant SKU/GTIN, sorgu dizisiz adres
(kopyalanır, tıklanmaz — çıkış `click` üretmeli) ve resolver'ın skor
açıklaması. Red nedeni: R, sonra 1–5 (farklı ürün, renk, boyut, bozuk veri,
diğer), 0 nedensiz, Esc vazgeç. Onay, teklif bu
arada başka bir ürüne bağlandıysa bağı ezmez; ekranda uyarı çıkar, satırda
kalınır. Kaydedilemeyen karar sessizce atlanmaz. Onay ve red denetim kaydına
yazılır; reddedilen çift veri toplama tarafında bir daha önerilmez (0040).

---

## `/yonetim/sozluk`

`lexicon` tablosunun tablo görünümü. Satır içi düzenleme, tür filtresi, arama.
Yeni satır eklendiğinde ayrıştırıcı anında etkilenir; sürüm çıkmaz. Liste 50'şer
satırlık sayfalıdır; silme onay penceresi ister. Girdi sunucuda doğrulanır
(tür, yüzey 1–80, karşılık 1–120, ağırlık 0–10); her değişiklik denetim
kaydına önce/sonra ile yazılır.

Ekranın üstünde son 7 günde kademe 3'e düşen sorguların listesi durur — sözlüğe
eklenecek adaylar oradan seçilir.
