# 0214 — Ürün türünü koruyan gevşetme ve baş isim seçimi

Tarih: 16 Kasım 2026. Bağlı: 0029 (metin kapısı), 0066 (fallback), 0129 (aday kümesi), 0170 (ürün türü), 0206 (adım bütçesi).

## Sorun
Kapı ve aday dalları SON slotu baş isim sayar. "dikey süpürge hafif" sorgusunda baş isim "hafif" olur: kremler,
direnç bantları ve aksesuarlar gelir, gerçek süpürge (Dyson V15) adaya girmez. `head_only` adımı da son kelimeye
düşer; altı kelimelik sorgu tek adımda tek kelimeye iner.

## Karar (yalnız bu değişiklikler)
1. **Baş isim = ürün türü** (`product-type.ts`, `headTypeToken`): tür son kelime değilse ve ardından yalnız
   niteleyici kelimeler geliyorsa o slot/belirteç sona alınır (`headTypeFirst`, `headTypeLast`). Model ayrıntısı
   (sayı, sürüm eki) izliyorsa ("iphone 17 pro max") dokunulmaz. Sıfat ekli gövde (`şarjlı`, `kablolu`) tür
   sayılmaz. Zorunlu tür deseni (anlamsal kapı) değişmedi.
2. **Aşamalı gevşetme** (yalnız tür güvenilirse): `qualifier_relaxed` adımları türü ve ona orijinal sorguda en
   yakın niteleyicileri tutar (sol komşu önce); en fazla iki ara adım (5+ kelimede 3 ve 2 belirteç), sonra
   `head_only`. Tür bilinmiyorsa eski davranış (doğrudan son kelime).
3. **Tür-doğru son çare** (`head_only`, `essential`): süre bütçesi dolsa da, hiç sonuç yokken, kendi adım bütçesiyle
   (0206) çalışır; ara adımlar onu aç bırakmaz.
4. **Sessiz olmayan yakın sonuç:** exact adımından gelen, eksik tokenı olan yakın sonuç (`tier != exact`) artık
   eksik tokenları `relaxed` olarak taşır (`token:<kelime>`). Baş isim doğru seçilince "kırmızı sneaker" gibi sorgularda
   siyah/beyaz sneaker aday olur; bu sonucun "kırmızı"yı gevşettiği kullanıcıya söylenmeli (CI testi: "a relaxed
   search reports what it relaxed").
5. `RESOLVER_VERSION` 5: eski çözümleme satırları bir kez yeniden ayrıştırılır (slot sırası değişti).

## Ölçüm (yerel e4-evaldb 160 bin ürün; üretim salt-okunur sonda)
- "ince uzun saplı mutfak spatulası silikon": boş → 12 ilgili spatula/silikon sonucu.
- "kablosuz dikey süpürge hafif şarjlı": ilk 5 kedi çeşmesi/süt köpürtücü/testere → Dyson V15 dahil süpürgeler.
- "kadın dolgu topuk terlik", "siyah kablosuz hafif bluetooth kulaklık spor için": aynı ya da benzer ilk 5; ek
  adım +0–0,6 sn yerelde.
- Değişmeyenler (kontrol): kablosuz kulaklık, iphone 17 pro max, telefon için hızlı şarj aleti, erkek siyah deri
  cüzdan kartlıklı, büyük boy çelik beslenme kutusu kapaklı, qzxwvkj.

## Sınırlar (düzelmeyenler)
- **"dikey süpürge hafif" (3 kelime) YEREL olarak düzelmedi:** kapı en çok bir eksiğe izin verir; "vacuum" eş
  anlamlısı "vacuum cup/bag" başlıklarını da yakalar ve Dyson başlığı ("... Kablosuz Süpürge") ne "dikey" ne "hafif"
  içerdiği için eşleşmez. Bu bir sözlük/kapı sorunudur (üretim sözlüğü ve kapı eşiği bu kararın dışında).
- **Üretimde "kablosuz kulaklık", "dikey süpürge hafif", "kablosuz dikey süpürge hafif şarjlı" EXACT adımda 5 sn
  zaman aşımına düşüyor** (öncesi ve sonrası aynı). Bu karar fallback'i etkiler; exact adımını değil (ayrı iş).
- Gerçek sorgu yorumu (IntentV2) ve ücretli model kullanılmadı.
