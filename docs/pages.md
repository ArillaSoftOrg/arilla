# Sayfalar

Her sayfada hangi bileşen, hangi sırada, hangi boş durumda ne yazacağı. Bu
dosya olmadan her ekran farklı mantıkla kurulur.

Bileşen adları `design.md` envanteriyle aynıdır. Metinler `copy.md` içindedir.

---

## `/` Ana sayfa

**Tek iş:** arama başlatmak.

| Sıra | Bileşen | Not |
| --- | --- | --- |
| 1 | Logo + üst çubuk | Giriş yapmamışsa "Giriş yap" bağlantısı |
| 2 | Arama girdisi | Fotoğraf yükleme aynı girdinin içinde. Otomatik odaklanır. |
| 3 | Kısa açıklama | Tek satır. Uzun karşılama metni yok. |
| 4 | Keşfet ızgarası | `discovery_slot` bugünün kaydı, 20 ürün |
| 5 | Altbilgi | Affiliate bildirimi, hukuki bağlantılar |

Kayıt istenmez. Kaydırma gerektiren tanıtım bölümleri yok.

**Boş durum:** yok. Keşfet ızgarası her zaman doludur (curated havuz).

---

## `/ara` Arama sonucu

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

**Boş sonuç:** filtreleri gevşetme önerisi + en yakın 6 sonuç. Tamamen boş
ekran gösterilmez.

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
| 7 | Mağaza listesi | Fiyat, kargo dahil toplam, stok, çıkış düğmesi |
| 8 | Kaydet / alarm kur | Giriş yoksa modal açılır |
| 9 | Diğer renkler | `model_key` eşleşmesi varsa |
| 10 | Alternatif şeridi | `similarity_edge`, 4-6 ürün, yatay kaydırma |
| 11 | Fiyat grafiği | Katlanmış, tıklayınca açılır |
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

Ara ekran gösterilmez. Affiliate bildirimi ürün sayfasında ve altbilgide
bulunur, çıkışta kullanıcıyı bekletmez.

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

## `/trend` ve `/trend/<slug>`

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

`/gecmis` sayfasında **silme düğmesi zorunludur** ve gerçekten silmelidir.

`/alarmlar` üç alarm türünü tek listede gösterir; tür rozetle ayrılır.

---

## `/hesap`

| Bölüm | İçerik |
| --- | --- |
| Profil | E-posta, görünen ad |
| Beden profili | Kategori başına beden |
| Tema | Sistem / açık / koyu |
| İzinler | Gezinme geçmişi, kişiselleştirme, ticari e-posta, keşfet akışı |
| Verilerim | İndir (JSON), gezinme geçmişini sil, hesabı sil |

Silme akışı gerçekten çalışmalıdır. Onay adımı vardır ama geri alınamaz olduğu
açıkça yazılır.

---

## `/giris`

Tek alan: e-posta. Gönderim sonrası "bağlantı gönderildi" ekranı.

Aynı e-postaya arka arkaya istek oran sınırına takılır ve kullanıcıya
"birazdan tekrar dene" denir. Hesabın var olup olmadığı **belli edilmez** —
her iki durumda aynı mesaj gösterilir.

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

---

## `/yonetim/sozluk`

`lexicon` tablosunun tablo görünümü. Satır içi düzenleme, tür filtresi, arama.
Yeni satır eklendiğinde ayrıştırıcı anında etkilenir; sürüm çıkmaz.

Ekranın üstünde son 7 günde kademe 3'e düşen sorguların listesi durur — sözlüğe
eklenecek adaylar oradan seçilir.
