# 0193 — Her public sayfada tek footer

Durum: **kabul**. İlgili: 0093, 0192.

## Bağlam

Canlıda üç farklı footer vardı: ürün erişimi açık ana sayfadaki standart `SiteFooter`, lansman
öncesi sayfadaki `SiteFooter` "prelaunch" sürümü (sosyal bağlantı yok, kısa link listesi, farklı
zemin) ve editoryal sayfalardaki (`/hakkinda`, `/blog`, `/ortakliklar`) ayrı `EditorialFooter`
(logo ve marka açıklaması yok). 0192 renkleri eşitledi ama yapı farklı kaldı.

## Karar

- Sohbet yüzeyi dışındaki her public sayfa, ürün erişimi açık ana sayfadaki standart
  `SiteFooter`'ı kullanır: logo + açıklama, link grupları, "Takipte kal" sosyal bağlantıları,
  fiyat uyarısı, kelime işareti.
- `EditorialFooter` kaldırıldı; `fullBleed` yalnızca dış Container'ı kaldırır.
- Lansman öncesi sayfa footer'ı da standart sürümdür. `footerVariant="prelaunch"` artık yalnızca
  header davranışını (hesap/admin bağlantısının menüde olması) belirler.
- Link içeriği kullanıcının erişimine göre değişmeye devam eder (erken erişim kullanıcısına ürün
  bağlantısı gösterilmez); bu bir içerik kuralıdır, görünüm değil.

## Reddedilen alternatif

- Her yerde "prelaunch" sürümü: lansmandan sonra kullanıcıya açılacak footer standart sürümdür;
  hedef o.
