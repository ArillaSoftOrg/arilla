# Marka

## İsim

**Arilla.** İsim ve alan adı ileride değişebilir; bu yüzden marka adı koda
gömülmez, tek bir yapılandırma değerinden okunur.

Yapılacak: TÜRKPATENT marka araştırması. İsim değişecek olsa bile bugün
kullanılan ismin başkasına ait olmadığından emin olunmalı.

## Alan adı

Şu anki: `yusufsari.info` — **yalnızca geliştirme için.**

Üç sorunu var: kişisel bir isim taşıyor, `.info` uzantısı e-posta teslimatında
düşük itibarlı sayılıyor, ve giriş bağlantıları bu alan adından giderse spam'e
düşme riski yüksek. Giriş akışı tamamen e-postaya bağlı olduğundan bu doğrudan
ürünü kırar.

**Gerçek kullanıcıya çıkmadan önce Arilla adına bir alan adı alınmalı.**
SPF, DKIM ve DMARC kayıtlarının yayılması bir gün sürüyor; bu iş lansman
haftasına bırakılamaz.

Ayrıca link öneki özelliği için kısa bir ikinci alan adı gerekiyor
(bkz. `routes.md`).

## Logo

Mevcut logo (`logoarilla.png`) **geçici yer tutucudur.** Üretimde kullanılmadan
önce yeniden çizilmesi gerekiyor.

Sorunlar:

| Sorun | Sonucu |
| --- | --- |
| Raster, 3B, gradyanlı | SVG'ye çevrilemez, ölçeklenmez |
| Eğim ve parlama efektleri | `design.md` düz yüzey kuralıyla çelişir |
| 16px'te detay kayboluyor | Favicon olarak kullanılamaz |
| Tek renkli sürüm yok | Koyu temada siyah kısım kayboluyor |
| "AS" okunuyor | İsimle uyuşmuyor |

Yeni logonun karşılaması gerekenler:

1. **SVG, düz, tek katman.** Gradyan, gölge, eğim yok.
2. **Tek renkli sürüm zorunlu.** Beyaz üzerine koyu, koyu üzerine açık.
3. **16px'te okunabilir.** Favicon testi geçmeden onaylanmaz.
4. **Kare işaret + yatay logotip** iki ayrı dosya.
5. Türkçe karakter içermeyen bir logotip tercih edilir (uluslararasılaşma).

## Renk ayrımı — önemli

Marka mavisi ile ürün arayüzü paleti **ayrı tutulur**.

| Kullanım | Renk |
| --- | --- |
| Logo, pazarlama, sosyal medya, e-posta başlığı | Marka mavisi |
| Ürün arayüzü | Nötr palet + tasarruf yeşili (`design.md`) |

Gerekçe: arayüzdeki tek vurgu rengi tasarruf tutarıdır. İkinci bir güçlü renk
eklemek o vurgunun anlamını böler. Bu ayrım yaygın ve sağlıklıdır; marka
kimliği ile ürün arayüzü aynı şey olmak zorunda değildir.

Marka mavisinin kesin hex değeri yeni logo çizildiğinde sabitlenir.

## Tipografi

**IBM Plex Sans.** SIL Open Font License, genişletilmiş Latin desteği Türkçe
karakterleri tam kapsıyor, tabular rakam mevcut, nötr ama karaktersiz değil.

Değerlendirilip elenenler: Inter (güvenli ama çok yaygın), Open Sans (açık
kaynak ve Türkçe destekli fakat 2011 tasarımı, rakamları fiyat ağırlıklı bir
arayüz için yeterince net değil).

### Servis etme kuralı

Font **kendi sunucumuzdan** servis edilir, Google Fonts CDN kullanılmaz.

Sebebi hukuki: CDN'den çekim kullanıcının IP adresini yurt dışındaki bir
sunucuya iletir ve `kvkk.md` içindeki yurt dışına aktarım kalemine girer.
Dosyalar depoda tutulunca üçüncü taraf isteği hiç oluşmaz.

- Değişken (variable) sürüm: tek dosyada tüm ağırlıklar
- Latin Extended-A alt kümesi; diğer diller boşuna yer kaplar
- `font-variant-numeric: tabular-nums` fiyat gösterilen her yerde açık

### Onay testi

İlk sürümde çalıştırılır:

1. **Türkçe testi.** `ığşçöüİĞŞÇÖÜ` dizisi tüm ağırlıklarda render edilir.
   Özellikle noktasız `ı` ve noktalı `İ` kontrol edilir.
2. **Rakam testi.** Gerçek bir fiyat listesi alt alta dizilir
   (`1.290 TL`, `11.900 TL`, `990 TL`) ve tabular hizalama doğrulanır.

## Ses tonu

Arayüz metni kuralları `design.md` içinde. Marka iletişiminde ek olarak:

- Abartı yok. "Türkiye'nin en iyi" gibi ifadeler kullanılmaz; kanıtlanamaz ve
  güven zedeler.
- Rakam varsa gerçek olur. "Ortalama %40 tasarruf" ancak ölçülmüşse yazılır.
- "Dupe" kelimesi dış iletişimde de kullanılmaz. Kopya konumlandırma tavan koyar
  ve marka hakları açısından risklidir.

## Yapılacaklar

- [ ] TÜRKPATENT marka araştırması
- [ ] Arilla alan adı alımı
- [ ] Link öneki için kısa ikinci alan adı
- [ ] SPF, DKIM, DMARC kurulumu
- [ ] Logonun SVG ve tek renkli sürümleri
- [ ] Marka mavisinin hex değerinin sabitlenmesi
- [x] Font seçimi: IBM Plex Sans (bkz. karar 0009)
- [ ] Font onay testi (ilk sürümde)

---

*Mevcut logo dosyası: `docs/logo-placeholder.png` — geçici, üretimde kullanılmaz.*
