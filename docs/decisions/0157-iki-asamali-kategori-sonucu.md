# 0157 — İki aşamalı kategori sonucu: kaynak üst eşlemesi + hibrit öneri (yalnızca dosya)

Durum: kabul edildi (öneri dosyası üretimi). **Hiçbir ürün kategorisi yazılmaz**; eşlemeler AI
önerisidir, `confirmed` değildir.

## Bağlam

AliExpress'in 2.769.478 ürününün tamamında kaynak yolu var. Bu yol `offer.category_raw` alanında
duruyor, 275 farklı değer alıyor ve hepsi 2 seviyeli (`L1 > L2`). `product.category_id` ise yalnızca
1.898 üründe dolu. Hibrit motor (karar 0155) ürün başına en fazla 3 aday üretiyor ama nihai bir karar
vermiyor. `category_source_map` 6 satırda kalmış, hiçbiri onaylı değil.

## Karar

1. **Aşama 1 — `classify/data/source_parent_map.tsv`:** 275 kaynak yolunun her biri için tam bir
   satır. Durumlar:
   - `yuksek`: güvenilir üst kategori (`category.path`).
   - `inceleme`: güvenilir ortak üst yok. `aday_yolu` yalnızca ipucudur, karar için kullanılmaz.
   - `eslesmedi`: ürün değil (fark ödeme, test, beden tablosu kayıtları) ya da ağaçta karşılığı yok.

   Varsayılan kural `source_bridge.tsv` bölgelerinden çıkar. Bölgeler tek kökteyse ortak ataları
   üst kategori olur. Farklı köklere yayılıyorsa ortak üst uydurulmaz, yol `inceleme` olur. Elle
   incelenen 27 istisnanın gerekçesi her satırın `gerekce` sütunundadır. Bunlar dar dalı
   güvenli ortak üste genişletme, ürün olmayan kayıtları ayırma ve karışık kaynakları incelemeye
   alma kararlarıdır. Testlerin güvenceleri:
   - Dosya köprüyle aynı kümedir; hiçbir kaynak yolu atlanmaz.
   - Her yol Trendyol planında bulunur.
   - `yuksek` satırların bütün bölgeleri o üst kategorinin içindedir. Bu sayede kabul edilen alt
     kategori asla üst kategorinin dışına çıkmaz.
2. **Aşama 2 — `classify suggest finalize`:** Hibrit çıktı, V5 kararı ve Aşama 1 birleştirilerek
   ürün başına tek bir karar üretilir. Kurallar şunlar:
   - **Korunan:** mevcut `category_id` olduğu gibi kalır.
   - **Alt kategori:** hibrit ilk aday `guclu` ya da `orta` durumdaysa, cihaz/parça/oyuncak cezası
     taşımıyorsa ve güvenilir üst kategorinin içindeyse alt kategori olur. Kaynağın üst kategorisi
     belirsizse ya da V5 başlık-kaynak çelişkisi (`conflict`) varsa yalnızca `guclu` kabul edilir.
   - **Üst kategori:** aday kabul edilmezse güvenilir üst kategoride kalınır.
   - **Belirsiz:** çelişki varsa ya da üst kategori yoksa ürün belirsiz kalır, hiçbir yere zorla
     yerleştirilmez.
3. **Çıktı:** Her ürün için kimlik, tam yol, ad yolu, seviye, karar kaynağı, hibrit durumu, kaynak
   üst kategorisi, V5 yolu ve aday listesi yazılır.
   - Kayıt `--shard` ürünlük parçalar halinde tutulur. Her parça önce geçici dosyaya yazılır, sonra
     yeniden adlandırılır.
   - `state.json` sürümleri tutar: karar kuralı, eşleme SHA-256 değeri, hibrit sürümü. Sürüm
     değişirse devam reddedilir.
   - Hibrit koşunun kontrol noktasını aşan parça yazılmaz.
   - Tekrar çalıştırma biten parçaları atlar.
   - Model yüklenmez, veritabanına bağlanılmaz.

## Ölçüm (400 ürün, AI etiketi — insan etiketi DEĞİLDİR)

Hibrit motor bu 400 ürün üzerinde, tam koşunun `index.npz` kalibrasyonuyla ayrıca çalıştırıldı.

- **Kaynak üst kategorisi (`yuksek`):** 274 üründe 224 doğru (%81,8). Dört eşleme istisnası bu
  örneğe bakılarak düzeltildi; ölçüm örnek içi olduğu için iyimserdir. Yanlışların çoğu satıcının
  ürünü yanlış AliExpress kategorisine koymasından kaynaklanıyor (ör. "Phone Decorations" altında
  far kapağı).
- **Alt kategori kararları (169 ürün):** 51 tam, 20 doğru ama kaba, 3 fazla derin, **95 yanlış**.
  `guclu` durumda bile 99'da 54 yanlış. Yanlışların çoğu doğru dalda ama yanlış yaprakta: 88'inde
  etiketle ortak dal derinliği 3 ya da daha fazla.
- **Yalnız üst kategori kararları (86 ürün):** 67'si doğru (tam ya da kaba), 19'u yanlış.
- **Belirsiz:** 145 ürün.

Sonuç: Yazmaya en yakın seviye kaynak üst kategorisidir. Hibrit alt kategori önerisi inceleme
içindir, otomatik atama için yeterli değildir.

## Reddedilen alternatifler

- **Kaynak yolunu tek başına yaprağa eşlemek:** 2 seviyeli yol, 3.862 Trendyol yaprağı için fazla
  kaba (karar 0154).
- **Farklı köklere yayılan kaynağa en büyük bölgeyi atamak:** Kaynak ürünleri gerçekten bölüyor;
  bu, kategori uydurmak olurdu.
- **V5 çelişkisini yok saymak:** `orta` ile çelişki bir aradayken örneklerde hata çok.
- **Sonucu `product.category_id` alanına yazmak:** İnsan etiketi (≥300) ve Wilson alt sınırı ≥0,80
  koşulu sağlanmadı (karar 0139 §7). Ayrıca yeni Trendyol düğümleri `is_discoverable = FALSE`.
