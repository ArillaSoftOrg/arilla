# URL yapısı ve sitemap

URL'ler geri alınamaz. Sonradan değiştirmek hem paylaşılmış linkleri hem SEO
sıralamasını kırar. Bu dosya kod yazılmadan önce kesinleşir.

## Namespace kararı

Kök dizin üç şey için yarışıyordu: creator profilleri, ürün sayfaları ve
yapıştırılan link öneki. Karar:

| Yüzey | Önek | Gerekçe |
| --- | --- | --- |
| Creator | `/@handle` | Instagram ve TikTok'tan tanıdık, kökü boşaltır |
| Ürün | `/urun/...` | Açık, SEO dostu |
| Link öneki | kök catch-all | Paylaşılabilirlik için en kısa hali gerekiyor |

Rezerve slug listesi tutulur: `ara`, `urun`, `kategori`, `marka`, `alternatif`,
`trend`, `firsatlar`, `kesfet`, `gecmis`, `alarmlar`, `kaydettiklerim`, `git`,
`api`, `panel`, `yonetim`, `hesap`, `giris`, `hakkinda`, `gizlilik`, `kosullar`,
`cerez`, `iletisim`, `kvkk-aydinlatma`, `affiliate-aciklamasi`, `sirket-bilgileri`,
`kullanim-kosullari`, `cerez-politikasi`.

## Kayıt duvarı

Duvar rotaya göre değişir. Genel bir kural değil, rota bazlı bir politikadır.

| Rota | Duvar |
| --- | --- |
| `/urun/`, `/kategori/`, `/alternatif/`, `/trend/`, `/firsatlar` | **Yok.** Arama motorundan gelinen sayfalar |
| `/@handle` ve creator koleksiyonları | **Yok.** Büyüme döngüsünün ilk halkası |
| `/ara` — metin, sohbet ve görsel arama | **Var.** İlk 2-3 sorgu serbest, sonrasında modal |
| Kaydetme, alarm, geçmiş, beden profili | **Var.** Zaten hesap gerektiren şeyler |

Modal sonuçların üstüne gelir, sonuçlar arkada durur. İçerik HTML'de kaldığı
için tarayıcı ve arama motoru görür; duvar güvenlik değil sürtünmedir.

**SEO sayfalarında modal asla gösterilmez.** Google, arama sonucundan gelen
ziyaretçiyi karşılayan araya girici modalları mobilde cezalandırır.

Modal metni kaydolmayı engel değil kazanç olarak sunar: "Hesabın yok mu?
Ücretsiz kaydol, bu sonuçları senin için saklayalım."

## Rotalar

### Genel

```
/                          Ana sayfa. Arama kutusu + görsel yükleme.
/ara?q=...                 Metin araması. Netleştirme çubuğu burada.
/ara/gorsel                Görsel arama sonucu
/urun/<slug>               Ürün sayfası: karşılaştırma, fiyat geçmişi, alternatifler
/git/<clickId>             Merchant'a çıkış. 302. Attribution burada yazılır.
```

Fiyat geçmişi ayrı sayfa değil, ürün sayfasının bir bölümüdür. Ayrı sayfa hem
SEO değerini böler hem kullanıcıyı gereksiz bir tıklamaya zorlar.

### Yasal / bilgi (Faz 6)

```
/gizlilik                  Veri kullanımı - taslak, hukukçu onayı bekliyor
/kosullar                  Kullanım koşulları - taslak, hukukçu onayı bekliyor
/cerez                     Çerez politikası, envanter ve tercih formu (#tercihler)
/iletisim                  Geçici public e-posta (Faz 8.1) - tek kaynak legal-identity.ts
/kvkk-aydinlatma           KVKK aydınlatma metni (karar 0038)
/affiliate-aciklamasi      Affiliate açıklaması (karar 0038)
/sirket-bilgileri          Şirket bilgileri - yalnızca doğrulanmış alanlar (karar 0038)
/kullanim-kosullari        Kalıcı yönlendirme (308) -> /kosullar
/cerez-politikasi          Kalıcı yönlendirme (308) -> /cerez
```

Karar 0038: hukuk paketi `/kullanim-kosullari` ve `/cerez-politikasi`
adlarını önerdi; canlı ve sitemap'teki `/kosullar` ve `/cerez` korunur, yeni
adlar yalnızca `next.config.ts` yönlendirmesidir. Yönlendirmeler sitemap'e
girmez.

`docs/sitemap.md`'nin statik sayfa aday listesindeki `/hakkinda` ve `/sss`
henüz **yazılmadı**, `STATIC_PAGES` listesinde ve footer'da yok. `/iletisim`
Faz 8.1'de eklendi (`STATIC_PAGES` ve footer'da); yalnızca kullanıcının
onayladığı geçici e-postayı içerir, telefon/adres uydurulmadı.

### Keşif

```
/kesfet                    Herkese açık koleksiyonlar ve creator vitrinleri
/trend/<slug>              'yaz-trend-parfumleri' — dönem boyunca SABİT
/trend                     Tüm trend listeleri
/firsatlar                 Fiyatı düşenler, günlük üretilir
/kategori/<path>           Kategori sayfası
/marka/<slug>              Marka sayfası
/alternatif/<product-slug> "X'e benzer daha uygun fiyatlı ürünler"
```

`/kesfet` iki tür içerik gösterir:

1. **Açıkça paylaşılmış içerik** — creator koleksiyonları ve `is_public`
   işaretli listeler. Sahibi görünür.
2. **İsimsiz keşifler** — "diğer kullanıcıların bulduğu ürünler". `public_find`
   tablosundan `source = 'organic'` kayıtlar. Hiçbir kullanıcı adı, avatarı
   veya profili gösterilmez.
3. **Bugün öne çıkanlar** — soğuk başlangıç için elle seçilmiş havuz
   (`source = 'curated'`). Günlük 20 ürünlük rotasyon, `discovery_slot`
   tablosundan.

İkinci tür üç korumayla sınırlıdır: kategori `is_discoverable` olmalı, ürün en
az birkaç farklı kullanıcı tarafından bulunmuş olmalı, ve zaman damgası
bulanıklaştırılır ("bu hafta", "7 saat önce" değil). Kullanıcı `/hesap`
altından tamamen dışında kalabilir.

İç giyim ve mahrem ürün kategorileri (örn. `ic-giyim`) bu akışa hiç girmez;
Süpermarket ve Petshop ise `is_discoverable = false` olduğu için aynı şekilde
dışarıda kalır (bkz. `docs/decisions/0023`).

### Soğuk başlangıç ve etiket dürüstlüğü

Platform kullanıcısı yokken ızgara elle seçilmiş ~300 ürünlük bir havuzdan
doldurulur, günde 20 ürün dönecek şekilde.

**Etiket içerikle uyumlu olmak zorundadır.** Seçilmiş ürünler "diğer
kullanıcıların bulduğu" başlığı altında gösterilmez — kimse bulmamıştır ve bu
yanıltıcı ticari uygulamadır. Doğru başlıklar: "Bugün öne çıkanlar", "Keşfet",
"Editörün seçtikleri". Aradığımız canlılık hissi başlıktan değil, ızgaranın
dolu ve ürünlerin iyi olmasından gelir.

"Kullanıcıların bulduğu" bölümü ayrı bir bölüm olarak, gerçek veri eşiği
geçtiğinde açılır. Elle kapatma gerekmez: organik kayıtlar arttıkça curated
payı kendiliğinden düşer.

Havuz seçim kriterleri: temiz ve yüksek çözünürlüklü fotoğraf (ızgara tamamen
fotoğraftan ibarettir, kötü fotoğraf tümünü ucuz gösterir), iyi fiyat konumu,
dengeli kategori dağılımı, stokta olma.

Bu akışın ikinci faydası: creator henüz yokken bile site canlı görünür, boş
platform sorununu hafifletir.

### Creator

```
/@<handle>                     Creator vitrini
/@<handle>/<collection-slug>   Tek koleksiyon
/panel                         Creator dashboard (auth)
/panel/koleksiyonlar
/panel/kazanc
/panel/baglantilar             Affiliate hesap bağlama
```

### Kullanıcı (giriş gerekli)

```
/kaydettiklerim            Favoriler
/alarmlar                  Fiyat düşüşü, yeniden stok ve beden alarmları
/gecmis                    Son gezilenler. Silme düğmesi zorunlu.
/hesap                     Beden profili, rıza tercihleri, veri silme
/giris                     E-posta bağlantısı isteme
/giris/dogrula?token=...   Bağlantı doğrulama. Tek kullanımlık, 15 dk.
```

`/hesap` altında gezinme geçmişini ve hesabı silme seçenekleri gerçekten
çalışmalıdır. KVKK gereği, arayüzde var görünüp arkada silmemek ihlaldir.

### Yönetim (rol gerekli)

Önceki sürümde tamamen eksikti.

```
/yonetim                   Genel bakış: yalnızca gerçek sayılar (kuyruk, eşleşmemiş
                           teklif, mağaza, koşu, link/görsel akışı, model maliyeti)
/yonetim/eslestirme        match_candidate kuyruğu. Onayla / reddet.
/yonetim/sozluk            lexicon düzenleme (sayfalı, silme onaylı)
/yonetim/denetim           admin_audit_event, salt okunur (yalnızca admin)
/yonetim/magazalar         (Faz 2) Mağaza listesi, koşu geçmişi, aç/kapat
/yonetim/ingest            (Faz 2) ingest_run durumu ve hatalar
/yonetim/trend             (ertelendi) trend_snapshot yayınlama onayı
```

Tek kabuk (`app/yonetim/layout.tsx`), tek yetki kapısı: her sayfa ve server
action `requireCapability(<yetenek>)` çağırır, core mutasyonu aynı yeteneği
ikinci kez denetler (docs/decisions/0039). Anonim → `/giris`, girişli ama
yetkisiz → 404. Rol → yetenek haritası: `packages/core/src/admin/capabilities.ts`.
Her mutasyon `admin_audit_event`'e aynı işlemde yazılır.

`/yonetim/eslestirme` MVP'de gereklidir. Eşleştirme kuyruğunu onaylayacak bir
ekran olmadan katalog kalitesi yönetilemez.

### İç uçlar

```
/api/cron/trigger-alerts            Vercel Cron. CRON_SECRET ile korunur.
/api/cron/generate-discovery-slots  Vercel Cron, gece yarısı. CRON_SECRET.
```

`/yonetim/sozluk` ürünün en çok bakım gören ekranı olacak. Sözlük
veritabanında tutulduğu için buradan eklenen bir eşanlamlı aramayı anında
iyileştirir, sürüm çıkmaya gerek kalmaz.

### Link öneki

```
/<merchant-url>            Örn: /https://www.trendyol.com/...
```

Önek yalnızca bir **kısayoldur** (docs/decisions/0035): dış adres geri
kurulur ve kanonik link araması adresine yönlendirilir. Arama kutusuna
yapıştırılan link (`/ara?q=https://...` ya da ana sayfa kutusunun kodlu
`/https%3A%2F%2F...` biçimi) de aynı adrese gelir:

```
/ara/link?url=<kodlanmış kanonik adres>    izleme parametresiz, fragment'sız
```

Akış: adres doğrula (SSRF yazım denetimi) → kanonik değilse kanonik adrese
307 → katalogda eşleşmiş ürün varsa `/urun/<slug>` → önbellekte sonuç varsa
göster → yoksa kuyruğa al, "Ürün inceleniyor…" bekle → sonuç ya da açık bir
hata. Fiyatlı ürün sayfası `discovery_source = 'user_link'` ile kataloğa
kalıcı olarak yazılır; fiyatsız ürün sayfası yalnızca arama sinyalidir.

Bilinmeyen ürün akışı ilk günden çalışmalıdır. Paylaşılan linklerin önemli bir
kısmı katalogda olmayan ürüne gidecek.

**Öneri:** Bu özellik için kısa bir ikinci alan adı alın. Paylaşılabilirlik
uzunlukla ters orantılıdır.

## Teknik kurallar

- Slug'lar Türkçe karakter içermez: `ç→c`, `ğ→g`, `ı→i`, `ö→o`, `ş→s`, `ü→u`
- Slug değişirse `product_slug_history` üzerinden 301 yönlendirilir. Hiçbir URL ölmez.
- Ürün sayfalarında `Product` ve `Offer` yapılandırılmış verisi (schema.org)
- Sayfalama `?sayfa=2`, `rel=next/prev` ile
- `robots.txt`: `/git/`, `/panel/`, `/yonetim/`, `/gecmis`, `/hesap` indekslenmez
- Sitemap parçalı üretilir, dosya başına en fazla 50.000 URL
- `/trend/` ve `/firsatlar` ISR ile üretilir, istek anında hesaplanmaz
- **Trend sayfaları günlük değişmez.** Google sıralamaya almak için içeriğin
  bir süre kararlı kalmasını ister; her gün baştan yazılan sayfa hiç sıralanmaz.
  Günlük rotasyon yalnızca `/kesfet` ızgarasına özgüdür.

## Faz dağılımı

| Faz | Rotalar |
| --- | --- |
| MVP-0 | `/`, `/ara`, `/ara/gorsel`, `/urun/<slug>`, `/git/<clickId>`, kök catch-all, `/yonetim/eslestirme`, `/yonetim/sozluk` |
| MVP-1 | `/giris`, `/kaydettiklerim`, `/alarmlar`, `/gecmis`, `/hesap`, `/firsatlar` |
| MVP-2 | `/@handle`, `/panel/*`, `/kesfet` |
| Faz 4 | `/trend/<slug>`, `/kategori`, `/marka`, `/alternatif` |

Yönetim ekranlarının MVP-0'da olması sürpriz gelebilir; sebebi eşleştirme
kuyruğunun ilk günden dolmaya başlaması. Onaysız kuyruk, kötü katalog demektir.
