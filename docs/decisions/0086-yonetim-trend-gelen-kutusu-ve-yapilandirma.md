# 0086 — Yönetim Faz D: trend yönetimi, gelen kutusu triyajı, başvuru listesi, yapılandırma görünümü

**Tarih:** 9 Ekim 2026
**Durum:** Kabul edildi

Yönetime ilk operasyonel yönetim özelliklerini, mevcut şemayla ve migration
OLMADAN ekler. Yetki haritası (0039), denetim kaydı, taze giriş kuralı, kapsam
kaydı (0082) ve tasarım sistemi (0083, 0084) değişmez.

## Karar

1. **Yeni yetenekler (yalnızca yönetici):** `trends.manage`,
   `messages.triage`, `config.read`. Moderatöre açılmaz. Sayfa
   `requireCapability`, action `requireCapability`/`requireFreshCapability`,
   core `assertCapability`; yetki reddi veritabanından önce olur (test).
2. **`/yonetim/trendler`**: durum, görünürlük, öne çıkarma, sıra, bağlı ve
   gösterilebilir ürün sayısı, yayın penceresi. Görünürlük public kuralla aynı
   ifadeden hesaplanır (`TREND_SHOWABLE_PRODUCT_SQL`, yayında + en az
   `MIN_PUBLIC_TREND_PRODUCTS`); eşik altı yayın yapılabilir ama ekranda
   uyarılır ve public'te görünmez. Geçişler: taslak → yayında/arşiv, yayında →
   taslak/arşiv, arşiv → taslak. Yayınlama, yayından kaldırma, arşivleme, geri
   alma, öne çıkarma ve sıra değişikliği **gerekçe (5–500) + taze giriş**
   ister; satır `FOR UPDATE` kilitlenir, beklenen eski durum tutmazsa
   `conflict`, değişiklik ve denetim satırı **aynı işlemde** yazılır (denetim
   yazılamazsa değişiklik geri alınır — test). Yönetim
   `trend_product`'a yazmaz. Curate işi yalnızca `trend_product` ve
   `trend.updated_at` yazar; yönetimin durum, öne çıkarma ve sıra kararlarını
   ezmez. Eşzamanlılık bu yüzden `updated_at` ile değil, beklenen durumla
   denetlenir.
3. **`/yonetim/mesajlar` triyajı**: mevcut `status` ve `priority` kolonları;
   durum ve öncelik filtresi. Geçişler yalnızca izinli olanlar (kapanmış mesaj
   yalnızca "incelemede"ye geri açılır). **Gerekçe ve taze giriş istenmez**
   (kamuya etkisi yok) ama her değişiklik aynı işlemde denetlenir; denetime
   yalnızca durum/öncelik değerleri gider, içerik/ad/e-posta asla.
4. **`/yonetim/erken-erisim` başvuru listesi**: salt okunur, yalnızca hesabın
   public kimliği, imleçli sayfalama (`(created_at, user_id)`, zaman veritabanı
   hassasiyetinde karşılaştırılır). Erişim verme/durum değiştirme YOK:
   `early_access.status` yalnızca `pending` alabilir; yeni durum migration ve
   onaylı iş akışı gerektirir.
5. **`/yonetim/ayarlar`**: etkin bayrak, kota ve tavanların salt okunur
   görünümü (`getConfigView`). Sırlar (anahtar, parola, token, bağlantı adresi,
   test alıcı listesi) yalnızca tanımlı/tanımsız/geçersiz durumu taşır, değer
   core'dan hiç dönmez (test: çıktıda sır parçası yok). Durumlar: tanımlı,
   varsayılan, tanımsız, geçersiz, bilinmiyor (yalnızca Python ortamının
   okuduğu ayarlar). Çalışırken değiştirme yoktur.

## Reddedilen alternatifler

- **Sorumlu kişi (`feedback.handled_by/handled_at`)**: migration gerektirir;
  bu fazda eklenmedi. Kimin değiştirdiği denetim kaydında.
- **Erken erişim onayı**: yeni durum değeri + migration + iş akışı; ayrı karar.
- **Trend sırasını sürükle-bırak ile toplu yazma**: tek denetim satırında çok
  satır değişirdi; komşuyla yer değiştirme tek ve izlenebilir adımdır.
- **Yapılandırmayı panelden düzenleme**: dağıtım ortamı tek doğruluk kaynağı;
  çalışırken değiştirme gizli durum ve yetki riski getirir.
