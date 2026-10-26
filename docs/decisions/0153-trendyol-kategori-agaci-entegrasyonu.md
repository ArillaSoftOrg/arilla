# 0153 — Trendyol kategori ağacının aktif kategori sistemine entegrasyonu

**Tarih:** 27 Ekim 2026
**Durum:** Önerildi (PR). Birleştirme ve dağıtım kullanıcı onayına bağlıdır; üretim verisine dokunulmadı
(yalnız salt okunur sorgular). Migration 0102 (veri; şema değişikliği yok).
**İlişkili:** 0133 (merkezi ağaç), 0143 (Trendyol referansı, 0096/0097), 0138–0142 (sınıflandırıcı V5)

## 1. Karar

Trendyol'un 3.867 kategorisinin **tamamı** (16 ana kategori, 6 seviye) aktif `category` ağacına, kendi
hiyerarşisiyle girer. Her Trendyol kategorisi için kalıcı bir `external_category_map` satırı vardır.
Mevcut 158 kategori **hiçbir şekilde değişmez** (kimlik, slug, ad, yol, ebeveyn, keşfet bayrağı, ürün
ilişkileri). Yeni kategoriler **boştur ve otomatik sınıflandırmaya kapalıdır** (§5).

| | Önce | Sonra (üretim) |
| --- | --- | --- |
| Kategori | 158 | **4.020** (158 + 3.862) |
| Ana kategori | 10 | **23** (10 + 13 yeni) |
| En fazla derinlik | 4 | **6** |
| Trendyol eşlemesi | 0 | **3.867 / 3.867** (3.862 oluşturuldu, 5 eşlendi) |

Girdi: `external_category` (0097, ham dosya sha256 `93fa9600…53ce`) ve entegrasyon öncesi ManiCepte
ağacının değişmez görüntüsü `docs/reference/categories/manicepte-baseline-158.tsv` (üretimden salt okunur
alındı; yeni veritabanında migration zinciri aynı 158 satırı üretir, testle doğrulanır).

## 2. Eşleme kuralı (varsayım yok)

Bir Trendyol düğümü, yalnızca **aynı ebeveyn bağlamında aynı (Türkçe katlanmış) ada** sahip **tek** bir
mevcut düğüme eşlenir (`exact_name`). Kök için ebeveyn bağlamı yoktur: aynı adlı tek mevcut kök.
Katlama: büyük/küçük, aksan, `&` `/` farkı yok sayılır (`Spor & Outdoor` = `Spor / Outdoor`,
`Süpermarket` = `Supermarket`); çoğul/ek farkı **yok sayılmaz** (`Akıllı Bileklik` ≠ `Akıllı Bileklikler`).

Eşlenenler (5): `Elektronik`, `Spor & Outdoor`, `Süpermarket` (kökler), `Elektronik > Telefon`,
`Elektronik > Giyilebilir Teknoloji`. Bunlar mevcut düğümlere bağlanır; altlarındaki Trendyol çocukları
o düğümlerin altında yeni düğüm olarak açılır.

Eşleme yapılmaz, ayrı düğüm oluşturulur: ayrı ebeveyn bağlamındaki aynı ad (örn. Trendyol `Giyim > Saat`
ile ManiCepte `moda/aksesuar/saat`), ayni ebeveynde ayni adli iki Trendyol kardeşi, aynı adlı birden çok
mevcut aday, anlamca benzer ama ad farklı olanlar (`Ağız Bakım` / `Ağız ve Diş Bakımı`). Bunların
birleştirilmesi insan kararıdır; `external_category_map` satırı **güncellenerek** sonradan yapılabilir
(`status = 'suggested'`/`confirmed`), kategori silinmeden.

`external_category_map.status`: eşlenen ve oluşturulan her satır `confirmed` + `decided_by =
'migration:0102'` + `note` (`exact_name` | `created`). Bu, *kimlik* eşlemesidir (düğüm bu Trendyol
düğümünden doğdu ya da kural gereği aynıdır); anlamsal denklik kararı değildir.

Yol: `ebeveyn yolu + '/' + slugify(ad)`; kardeşte çakışırsa `-ty<id>` eki (3 düğüm: `Akıllı Bileklik`,
`Akıllı Saat` mevcut `akilli-bileklik`/`akilli-saat` yollarıyla çakışır; kamp altındaki ikinci
`Elektronik Optik Ürünler`). Slug: yol `-` ile (0089 kuralı); tohum slug'ıyla çakışırsa `-ty<id>` (1 düğüm:
kök `Ayakkabı` → `ayakkabi-ty403`; tohum `ON CONFLICT (slug) DO UPDATE` ile onu ezerdi).

## 3. Migration 0102 (veri, idempotent, ekleme)

`packages/db/scripts/trendyol-category-tree.ts --generate`, planı hesaplayıp migration'ı, kalıcı eşleme
CSV'sini (`docs/reference/trendyol/category-tree-map.csv`, 3.867 satır) ve geri alma betiğini üretir;
`--check` ve birim testi uyumu doğrular. Migration: ad ve ebeveyn ilişkisi `external_category`'den okunur
(ikinci bir ad kopyası yok); satır `external_category_map`'te varsa atlanır (**idempotent**); yeni düğüm
`is_discoverable = FALSE`.

Güvenlik (lint kuralı `data-raise`: veri migration'ı dağıtımı düşürmez): beklenmedik durumda (mevcut düğüm
yok/adı farklı, yol zaten var, ebeveyn eşlemesi yok) o düğüm **uydurulmadan atlanır**, `NOTICE` ile
raporlanır; atlanan düğümün altındakiler de atlanır; tekrar çalıştırma kalanı işler. Başta
`external_category(trendyol) = 3.867` doğrulanır, değilse hiçbir şey yazılmaz.

Süre: bir DO bloğu, ~4 bin satır; yerelde saniyeler.

## 4. Tüketiciler ve etkiler

- **Frontend:** Kategori menüsü ya da `/kategori/<yol>` sayfası **henüz yok** (`docs/routes.md` Faz 4);
  tek tüketici yönetim ürün listesinin kategori süzgeci idi. O süzgeç tüm ağacı (`LIMIT 1000`, sessizce
  kesilirdi) tek `<select>`e basıyordu. Artık yalnız ana kategoriler ve ikinci seviye gelir; seçili dal
  (atalar, ata/kendi çocukları) açılır, seçim her zaman görünür. Süzgeç URL'si (`kategori=<yol>`, alt
  dallar dahil) ve sonuçlar değişmez. Gelecekteki herkese açık menü de kök + istek üzerine çocuk
  yüklemeli (`category_path_idx` önek araması), `is_discoverable` ve ürün sayısıyla süzülmelidir; tüm ağaç
  her istekte yüklenmez.
- **Arama:** Sorgu kelimeleri **ana kategori adlarıyla** eşleşir (karar 0131) ve eşleşen kökün tüm alt
  kategorileri sorguya girer. Ağaç 158 → 4.020 olunca eski sorgu (`category` × `category`) 2 ms'den
  34 ms'ye çıkıyordu; kökleri önce süzen eşdeğer biçime yeniden yazıldı (≈2,5 ms, aynı kimlikler; testle
  kanıtlı). Yeni ana kategoriler **boştur**: sonuç kümesi değişmez. Bir kök adı sorguyla eşleşirse yeni
  boş dalların kimlikleri de diziye girer (en büyük kök ~600 düğüm); ürün olmadığından sonuç değişmez,
  maliyet ihmal edilebilir. Ürünler yeni düğümlere bağlandıkça arama bunları görecektir (bilinçli).
- **SEO / site haritası / keşfet / trendler:** Yeni düğümler `is_discoverable = FALSE`: boş ve sınıflandırıcısız
  olduğundan sitemap, keşfet ve veri istihbaratı trend tablolarına girmezler. Ürün bağlanıp politika
  (hassas dallar: iç giyim, hamile, hijyen, tütün; süpermarket altı) gözden geçirilince dal dal açılır.
- **Sınıflandırıcı:** Davranış **değişmez**. V5 yalnız `taxonomy.RULES` yollarına yazar; hepsi eski 158
  düğümdendir (birim testi). Koşu başına `SELECT id, path FROM category` ~4 bin satır yükler (ihmal
  edilebilir). Yeni düğümlere kural eklemek ayrı karar + `RULE_VERSION` artışıdır; toplu sınıflandırma
  başlatılmaz. Mevcut ürünlerin kategorileri değişmez.
- **Ürün aramasında ürün/teklif/fiyat:** değişmez; hiçbir ürün yeni düğüme bağlı değildir.

## 5. Neden yeni düğümler kapalı (`is_discoverable = FALSE`) ve boş

Boş binlerce kategorinin kullanıcıya görünmesi, sitemap'e girmesi ve trend/öneri akışlarına karışması
istenmez. `is_discoverable` zaten "keşfet akışına girebilir mi" bayrağıdır (0089'da hassas dallar için
kullanıldı); kapalı olması aramayı ve veritabanı bütünlüğünü etkilemez ve geri alınabilir
(`UPDATE category SET is_discoverable = TRUE WHERE …`). Hangi dalın ne zaman açılacağı ürün bağlanınca
ayrı karar.

## 6. Ana kategori sayısı ve "zorla yeniden düzenleme yok"

Mevcut 10 ana kategori yerinde kalır; taşıma, birleştirme, yeniden adlandırma yok. Trendyol'un 13 yeni
kökü (Aksesuar, Anne & Bebek & Çocuk, Ayakkabı, Bahçe & Elektrikli El Aletleri, Banyo Yapı & Hırdavat,
Ek Hizmetler, Ev & Mobilya, Giyim, Hobi & Eğlence, Kırtasiye & Ofis Malzemeleri, Kitap, Kozmetik &
Kişisel Bakım, Otomobil & Motosiklet) ayrı kök olarak eklenir. Bazıları anlamca mevcut kökün dalıyla
örtüşür (ör. `Giyim` ≈ `moda`; `Kitap` ≈ `kitap-muzik-hobi/kitap`): bilinçli olarak birleştirilmedi
(varsayım gerekir); ileride `external_category_map` ile ya da ayrı bir yeniden ebeveynleme kararıyla
çözülür.

## 7. Reddedilen alternatifler

- **Anlamca benzerlik/bulanık eşleme** (ör. "Kadın Giyim" = "Giyim > Kadın"): varsayım gerektirir;
  yanlış birleştirme yanlış ürün ataması demektir. Yalnız belirleyici eşleme yapıldı.
- **Trendyol ağacını mevcut 10 köke dağıtmak (zorla yeniden düzenleme):** mevcut yollar, kurallar ve
  slug'lar değişirdi; istenmedi.
- **Her düğüm için `is_discoverable = TRUE`:** boş kategoriler sitemap/keşfete karışırdı.
- **Veri migration'ında `RAISE EXCEPTION`:** lint kuralına (`data-raise`) ve dağıtım güvenliği ilkesine
  aykırı; atla-ve-raporla seçildi.
- **Yeni sütun/tablo:** gerekmedi; `external_category_map` zaten kalıcı eşlemeyi taşır.
- **Menüde tüm ağacı yüklemek:** 4 binlik tek `<select>` ve `LIMIT 1000` kesintisi; seçili dal genişletmesi
  seçildi.

## 8. Geri alma

`docs/reference/trendyol/category-tree-rollback.sql` (elle ve onayla; migration değil): yalnız bu
migration'ın **oluşturduğu** 3.862 kategoriyi ve 3.867 eşleme satırını siler; mevcut 158'e dokunmaz. Tek
işlemde, tek `DELETE`: oluşturulan bir düğüme ürün, sınıflandırma, kaynak eşlemesi ya da başka bir tablo
bağlıysa yabancı anahtar hata verir ve **hiçbir şey silinmez** (kısmi silme yok). Testle doğrulandı
(işlem içinde ROLLBACK; ürün bağlıyken hata).

## 9. Riskler ve açık işler

- Anlamca yinelenen düğümler (ör. iki `İç Giyim`, iki `Saat`) bilinçli olarak ayrı; kullanıcıya görünür
  olmadan önce (menü) bir birleştirme/gizleme kararı gerekir.
- Hassas dallar (iç giyim, hamile, hijyen, tütün, yetişkin) şu an kapalı; açılırken `is_discoverable` politikası
  gözden geçirilmeli.
- Trendyol ağacı kaynakta değişirse (kategori ekleme/kaldırma) yeni ham dosya + yeni migration gerekir;
  `external_category.retired_at` kalkanları şimdilik eşlemeyi etkilemez.
- Yeni düğümlere kural yazılmadan hiçbir ürün atanmaz; V5'in 3.102 inceleme kaydı bu PR ile değişmez.
