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
| 4 | Trendler | Editorial koleksiyon kartları (`id="trendler"`, header nav'ından anchor). Faz 2: geçici demo veri seti, bkz. `apps/web/data/demo/homepage-trends.ts` ve `SOURCES.md`. Admitad/feed entegrasyonu gelince gerçek veriyle değişir. |
| 5 | Keşif ızgarası | `id="kesfet"`. Masonry düzeni, `DiscoveryCard`. Veri `discovery_slot`'tan (`getDiscoverySlots`) gelir; adapter gerçek satırları `DiscoveryItem`'a çevirir. Faz 3.1: `discovery_slot` boşsa VE `HOMEPAGE_DEMO_CONTENT=true` ise (bkz. `.env.example`) `apps/web/data/demo/homepage-discovery.ts`teki demo veri setine düşer — `NODE_ENV`'e bağlı değil, açıkça etkinleştirilen bir içerik kararı (Admitad öncesi vitrin deploy'u için). Gerçek veri her zaman demo'nun önündedir. |
| 6 | Nasıl Çalışır | `id="nasil-calisir"`, header nav'ından anchor. Üç kart: metinle ara, fotoğrafla ara (ikisi de aktif), bağlantıyla bul (Faz 4: backend'de kök catch-all link çözümleme var ama arama kutusuna bağlı değil — "Yakında" etiketiyle gösterilir, sahte CTA yok). `HowItWorksCard`, veri `home-copy.ts`. |
| 7 | Şeffaflık | Faz 5: `HomeTrustSection`. Sosyal kanıt değil — doğrulanmamış kullanıcı/mağaza sayısı yok, yalnızca gerçek kabiliyetler (aynı/benzer ürün bulma, mağaza tekliflerini karşılaştırma, fiyat-stok bilgisinin mağaza kaynaklı ve güncellenme zamanlı olması). |
| 8 | Altbilgi | Faz 5: `SiteFooter`. Yalnızca gerçekten var olan route'lara link (`#trendler`, `/kesfet`, `#nasil-calisir`, `/firsatlar`, `/giris`, `/kaydettiklerim`, `/alarmlar`, `/gecmis`, Faz 6 sonrası `/gizlilik`, `/kosullar`, `/cerez`). `/hakkinda` yok, footer'da link YOK. Faz 8.1: `/iletisim` eklendi, Bilgi grubunda. Affiliate bildirimi (`legal.affiliate_notice`) ve fiyat/stok uyarısı (`legal.price_disclaimer`) tek, düzenli bir disclosure bandında — homepage'te başka hiçbir yerde tekrar edilmez. Faz 7: header ve footer'daki "Keşfet", keşif bölümü bu sayfada render edildiyse `#kesfet`'e, edilmediyse `/kesfet`'e gider — `/kesfet` bugün için `discovery_slot` yokken yalnızca boş durum gösterir. Faz 8: aynı header/footer public alt sayfalarda da kullanılır (`apps/web/app/public-site-shell.tsx`, route başına ince `layout.tsx`: `/kesfet`, `/firsatlar`, `/ara`, `/giris`, `/urun/[slug]`, `/gizlilik`, `/kosullar`, `/cerez`); orada bölüm linkleri `/#trendler`, `/kesfet`, `/#nasil-calisir`. Giriş gerektiren sayfalar ve `/yonetim` kabuk kullanmaz. |

Kayıt istenmez. Kaydırma gerektiren tanıtım bölümleri yok.

**Boş durum:** `discovery_slot` doluysa yok — keşif ızgarası her zaman
doludur (curated havuz). Boşsa (`discovery_slot` henüz üretilmemişse, cron
hiç çalışmadıysa) ve `HOMEPAGE_DEMO_CONTENT=false` (varsayılan) ise bölüm hiç
render edilmez, sessizce atlanır. `HOMEPAGE_DEMO_CONTENT=true` ise aynı boş
durumda demo veri seti devreye girer, sayfa görsel olarak boş kalmaz.

---

## `/gizlilik`, `/kosullar`, `/cerez` — Yasal/bilgi sayfaları (Faz 6)

`LegalPageLayout` (packages/ui) paylaşılan sarmalayıcı — okuma genişliği
(`--content-width-reading`), başlık + "son güncelleme" etiketi + içerik.
Faz 8: bu sayfalar public site kabuğunu (`public-site-shell.tsx`, header +
footer) kullanır — önceden header/footer'sız, çıkmaz sokak sayfalardı.

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
