# 0216 — Keşfet: sıra-koruyan masonry

**Karar.** `/kesfet` Keşfet'e özel `DiscoverMasonry`/`DiscoverCard` kullanır (`apps/web/app/kesfet/`).
Yerleşim CSS grid + `grid-row-end: span N`; satır yüksekliği `ResizeObserver` ile ölçülür. DOM sırası
mantıksal sıradır (Tab ve ekran okuyucu görsel okuma sırasını izler). Sütunlar: 2 (<640), 3 (≥640), 4 (≥1024).
Görsel oranı veride olmadığı için 4:5 yer tutucu ayrılır, `load` olayında doğal oran (0,66–1,4 aralığına
sıkıştırılmış; dışındakiler `contain`) uygulanır. Tekrar eden ürün `id` ile görünümde ayıklanır (seçilmiş önce).

**Gerekçe.** Ortak `DiscoveryGrid` ana sayfa `#kesfet`'i de besler; CSS `columns` okuma sırasını sütun sütun yapar.

**Reddedilen.** CSS `column-count` (okuma sırası bozulur); en kısa sütuna JS dağıtımı (DOM/odak sırası bozulur);
kalıcı çözüm olarak `product` görsel boyutu şemaya eklemek (migration; ayrı iş, CLS'i sıfırlar).
