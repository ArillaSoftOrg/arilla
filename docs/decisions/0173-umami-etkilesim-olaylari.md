# 0173 — Umami etkileşim olayları: sayfada kalma süresi ve bağlantı tıklamaları

**Tarih:** Kasım 2026 · **Durum:** kabul edildi · **Değiştirdiği:** 0116 §5 (olay listesi)

## Bağlam

Umami (0116) 8 Kasım 2026'dan beri üretimde ziyaret sayıyor. İki eksik görüldü:

- **Süre:** Umami ziyaret süresini ilk ve son olay arasından hesaplar. Otomatik izleme
  kapalı olduğundan tek sayfa görüp çıkan ziyaretin süresi 0 görünür; ortalama süre ve
  ziyaretçi başına süre olduğundan düşük çıkar.
- **Tıklama:** Ziyaretçinin hangi sayfadan ürüne ya da mağazaya geçtiği görünmüyor.

## Karar

1. Üç yeni Umami olayı (`docs/events.md` "Umami"): `page_engaged`, `product_opened`,
   `merchant_exit_clicked`. Hepsi 0116'nın kapısından geçer: yalnızca analitik rızasıyla,
   `ConsentGate` içinde, ölçülmeyen yollarda (`/yonetim`, `/api`, `/giris/*`,
   `/abonelik-iptali`) hiç gönderilmez, rıza geri alınınca anında durur.
2. **Veri yalnızca sabit sözlüklerden** (`packages/core/src/analytics-umami/events.ts`):
   sayfa alanı, çıkış yüzeyi (`CLICK_SURFACES` ile aynı, test korur), süre aralığı. Ürün,
   teklif, mağaza kimliği, fiyat, sorgu metni, IP, kullanıcı kimliği gönderilmez. Süre
   kesin değil aralıktır (parmak izi yüzeyini küçültür).
3. **Adres:** her olay sayfa görüntülemesiyle aynı arındırılmış adresi taşır; betiğe ek
   güvence olarak `data-exclude-search="true"` verilir (Umami'nin varsayılan adresi sorgu
   metni taşımasın).
4. **Bileşenlere dokunulmaz:** tıklamalar `UmamiClient` içinde tek bir belge dinleyicisiyle,
   bağlantı adresinin biçimine göre (`/urun/:slug`, `/git/:offerId`) sınıflanır.
   Gezinme engellenmez; Umami `keepalive` ile gönderir.
5. `page_engaged`: yalnızca sekme GÖRÜNÜRKEN geçen süre; sayfa görüntüleme başına en
   fazla bir olay (rota değişimi, sekmenin gizlenmesi ya da sayfanın kapanması — hangisi
   önce). Ziyaretçi sekmeye dönüp sonra çıkarsa ikinci olay gitmez (bilinçli eksik sayım).

## Reddedilen alternatifler

- **IP adresi saklamak / Umami'ye ayrıca göndermek:** KVKK kişisel verisi; CLAUDE.md
  analitik yükünde kişisel veriyi yasaklar. Konum Umami'nin IP'den türettiği ülke/bölgeyle
  sınırlı kalır, IP saklanmaz.
- **Kişiye bağlı süre (`identify`):** 0116'da reddedildi; profil çıkarma, ayrı hukuki
  karar ve açık rıza ister.
- **Isı haritası / oturum kaydı (Hotjar, Clarity, kendi sunucuda OpenReplay vb.):** üçüncü
  taraf betik yasağı; kendi sunucuda olsa bile form/ekran içeriği kaydı KVKK yükü getirir.
- **`click` tablosundan tıklama raporu:** 0049 §5 — `click` davranışsal analitiğe kaynak
  olarak kullanılmaz; davranış rızalı olaylarla ölçülür.
- **Her tıklamayı (`data-umami-event`) ya da kesin süreyi göndermek:** serbest metin ve
  ince taneli zaman damgası, yukarıdaki veri sınırını aşar.
