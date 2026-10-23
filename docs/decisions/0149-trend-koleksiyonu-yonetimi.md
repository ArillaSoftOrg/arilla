# 0149 — Trend koleksiyonu yönetimi: yönetim panelinden oluşturma ve elle ürün seçimi

**Tarih:** 24 Ekim 2026
**Durum:** Önerildi (PR). Üretimde koleksiyon oluşturma/yayınlama ayrı bir editoryal karardır.
**İlişkili:** 0077 (trend koleksiyonları), 0086 (yönetim: durum/öne çıkarma/sıra), 0147
(`trend.curation`, curate'in elle seçilmiş trendi koruması), 0039 (denetim kaydı)

## Sorun

0147 elle seçilmiş trendi mümkün kıldı, ama oluşturmanın ve ürün bağlamanın tek yolu
terminalden SQL çalıştırmaktı: gerekçe ve denetim kaydı yok, eşzamanlılık koruması
betiğe bağlı, yanlış ürün/eşik denetimi elle. `/yonetim/trendler` (0086) yalnızca durum,
öne çıkarma ve sırayı yönetiyordu; bağlar curate işinindi.

## Karar

1. Yeni core modülü `packages/core/src/admin/trend-collections.ts` (yetenek `trends.manage`,
   yalnızca yönetici): oluşturma, ayrıntı düzenleme, bağ sahipliği (`auto`/`manual`), elle
   seçilmiş trendin ürün bağları, editör görünümü ve ürün araması. Durum, öne çıkarma ve sıra
   `trends-admin.ts`'te kalır; tekrar yazılmaz.
2. Her yazım: gerekçe (5–500), satır kilidi (`FOR UPDATE`), istemcinin gördüğü değerle
   karşılaştırma (`expected*` tutmazsa `conflict`) ve denetim satırı AYNI işlemde. Yeni
   eylemler: `trends.create`, `trends.update`, `trends.curation`, `trends.products`.
   `updated_at` sürüm olarak kullanılmaz (curate onu da yazar).
3. Ürün bağları yalnızca `curation = 'manual'` trendde yazılır; otomatik trende yazım
   `not_manual` döner. Bağlanan ürün var olmalı ve yayında olmalı; liste sıralı, tekrarsız,
   en çok 48 ürün. curate (0147) yazmadan önce aynı trend satırını kilitleyip `curation`ı
   yeniden okuduğundan iki yazar aynı anda bağları değiştiremez.
4. **Yayın kapısı:** `setTrendStatus` yayına alırken eşiği satır kilidinden sonra, aynı işlemde
   sayar; `MIN_PUBLIC_TREND_PRODUCTS` (4) altındaysa `below_threshold` döner, yazmaz. Daha önce
   eşik altı yayın serbestti ve yalnızca ekranda uyarılıyordu. Yayındaki elle seçilmiş trendin
   bağları da eşiğin altına indirilemez. (Yayındaki trendin stok yüzünden eşik altına düşmesi
   public kuralla gizlenmeye devam eder.)
5. `slug` oluştururken verilir, sonra değişmez: yayınlanmış adres ölmesin.
6. Ürün kartı uyarıları (saf fonksiyon, birim testli): gösterilemez nedenler (yayında değil,
   görsel yok, TL fiyat yok, stok yok) ve bilgi uyarıları (fiyat 7 günden eski, etkin TL
   teklifi 7 gündür görülmedi, son 90 günde tek fiyat gözlemi, mağazalar arası fiyat farkı
   3 katı aşıyor, affiliate bağlantısı yok). Orijinallik iddiası değildir.
7. Ürün araması katalog aramasının aynısıdır (`searchProducts`, yalnızca yayındaki ürünler).
8. Migration yok, yeni bağımlılık yok. Ürün, teklif, fiyat ve stok satırlarına yazılmaz.
9. Arayüz: `/yonetim/trendler` listesine tür sütunu ve "Yeni koleksiyon"; `/yonetim/trendler/yeni`
   (taslak oluşturma) ve `/yonetim/trendler/[id]` (hazırlık, ürünler, ayrıntılar). Ürün sırası
   sürükle-bırak ya da klavyeyle (yukarı/aşağı düğmeleri) değişir; kayıt tek seferde, gerekçeyle.
   Durum/öne çıkarma/sıra mevcut diyalogla (0086) yapılır. Her action yetki matrisindedir (0082).

## Reddedilen alternatifler

- **Terminal SQL betiği** (`manual-trend-perfume.sql` gibi): gerekçe/denetim ve yetki modeli
  dışında kalır; tek seferlik provada kullanılabilir ama kalıcı yol olamaz.
- **Bağları `updated_at` ile sürümlemek:** curate otomatik trendi yeniden yazarken onu da
  günceller; yanlış çakışma üretir. Beklenen sıralı liste kesindir.
- **Ayrı bir CMS / koleksiyon tablosu:** `trend` + `trend_product` yeterli; ikinci kaynak
  public okuma yolunu ikiye bölerdi.
