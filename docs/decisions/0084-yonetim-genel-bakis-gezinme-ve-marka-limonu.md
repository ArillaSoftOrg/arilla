# 0084 — Yönetim Faz B.2: genel bakış düzeni, gezinme ve marka limonu

**Tarih:** 9 Ekim 2026
**Durum:** Kabul edildi

0083'ün (arayüz temeli) devamı. Adresler, yetenekler, server action'lar,
denetim kaydı ve veri kaynakları değişmez; yeni metrik yok. Migration yok.

## Karar

1. **Marka limonu belirteci.** `packages/ui/src/tokens.css`'e `--brand`
   (`#b7f52f`) ve `--on-brand` (`#16181d`) eklendi. Değer tahmin değil:
   uygulama ikonundaki "M" işaretinin baskın pikseli
   (`apps/web/app/apple-icon.png`, `icon/apple-touch-icon.png`). Bugün YALNIZCA
   `/yonetim` kullanır:
   - etkin gezinme öğesi: limon tonlu zemin (`color-mix`, açıkta %22, koyuda
     %16) + kalın metin + 3px limon işaret;
   - metin seçimi (`::selection`);
   - klavye odağı: halka `--focus-ring-color` (açıkta mürekkep, koyuda limon),
     halka ile öğe arası boşluk limon.
   Limon beyaz üzerinde ~1.3:1'dir: açık temada metin rengi ya da tek başına
   çizgi göstergesi olarak KULLANILMAZ (sekme alt çizgisi açıkta mürekkep,
   koyuda limon: `--admin-indicator`). Anlamsal renkler (`--alert`,
   `--warning`, `--save`) değişmez. Public arayüz bu belirteci kullanmaz;
   orada design.md "Marka ile ilişki" kuralı aynen geçerli.
2. **Genel bakış düzeni.** Göstergeler en üstte, önem sırasıyla tek dengeli
   ızgarada (9 kart: ≥ 768px 3 × 3, telefonda 2 sütun): bekleyen eşleştirme,
   toplama koşuları, model maliyeti (tahmini), metin araması, link araması,
   görsel yükleme, aktif mağaza, eşleşmemiş teklif, yeni kullanıcı. Veri
   temeli rozetleri aynen. Model maliyeti kartındaki çağrı/birim dökümü
   kaldırıldı (tam döküm `/yonetim/islemler#maliyet`'te); fiyatlanmamış çağrı
   notu kalır. ≥ 1280px'te uyarılar sağ sütunda; darda göstergelerin altında,
   kritik bulgu varsa üstünde. Başlıktaki önem özeti uyarı paneline bağlanır.
3. **Kısa uyarı listesi** (`AlertSummaryList`). Satır başına önem rozeti,
   teşhis sayfasına giden başlık, tek satır bağlam ve kanıt zamanı; anlam,
   kanıt ve "Ne yapmalı" aynı satırın "Ayrıntı ve önerilen adım" bölümünde
   (yerel `<details>`). Hiçbir uyarı ya da öneri düşmez; sıra core'dan
   (`sortFindings`, önce kritik); kritik satır tonlu zeminde. `/yonetim/islemler`
   tam `FindingList`'i kullanmaya devam eder.
4. **Gezinme.** Varsayılan: yalnızca etkin sayfanın grubu açık; diğerleri
   kapalı, öğe sayısını gösterir ve elle açılıp kapanır (oturum içinde
   korunur, tarayıcı deposu yok). Grup başlığı daha belirgin, grup içi öğeler
   ince kılavuz çizgisiyle girintili; marka işareti (uygulama ikonu) yan menü
   ve çekmecede. Rol süzmesi ve adresler değişmez.

## Reddedilen alternatifler

- **Limonu açık temada odak halkası/metin rengi yapmak:** WCAG 1.4.11 / 1.4.3
  altında kalır.
- **Limonu public arayüze de yaymak:** design.md "tek vurgu tasarruf" kuralı;
  ayrı karar ister.
- **Uyarıları kartlarda bırakıp yalnızca sayıyı göstermek:** öneri ve kanıt
  görünmez olurdu; ayrıntı satır içinde kalır.
- **Göstergeleri gruplu başlıklarla bırakmak:** 4 + 4 + 1 dengesiz ızgara.
