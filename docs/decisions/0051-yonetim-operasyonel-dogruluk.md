# 0051 — Yönetim ekranında operasyonel doğruluk ve önceliklendirme

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi

Salt okunur yönetim denetiminin (2026-10-03) bulguları: bazı ölçütler
gerçekte olduğundan farklı bir şey söylüyordu ve boru hattının büyük kısmı
görünmüyordu. Yetki haritası (0039), oturum kuralları (0044) ve görünürlük
sınırları DEĞİŞMEZ; migration yok.

## Karar

1. **Maliyet tek başına sayı değildir.** `api_usage.cost_micros` çağrı anındaki
   maliyet oranıyla yazılır; oran (`EMBEDDING_COST_MICROS_PER_1K_TOKENS`)
   tanımsızken 0 yazılır. Önbellekten dönmeyen ama maliyeti 0 olan çağrılar
   "fiyatlanmamış" sayılır (`packages/core/src/admin/cost-truth.ts`). Hepsi
   fiyatlanmamışsa tutar yerine "Hesaplanmadı", bir kısmıysa "en az X TL"
   gösterilir; çağrı, önbellek ve birim (token) sayıları her zaman gösterilir.
2. **Başarısız koşunun yazım sayıları gösterilmez.** Toplayıcı başarısız koşuyu
   geri alır ama koşu kaydı geri alınan yazımları sayar; ekran "geri alındı"
   der (`writesRolledBack`). Görülen kayıt sayısı gerçektir, kalır. Kaynağın
   (Python) düzeltilmesi ayrı iştir.
3. **Etiketler gerçeği söyler.** Ürünün `price_updated_at`/`min_price`/
   `offer_count` alanlarını yalnızca elle çalışan `similarity --prices` yazar:
   "fiyatı bayat" → "fiyat özeti 7+ gündür yenilenmedi". Elle çalışan işler
   "gece" diye etiketlenmez. Ham görsel hiç saklanmadığı için "ham dosya" ve
   "silinecek" sütunları kaldırıldı; depoda ham görsel görülürse beklenmeyen
   durum olarak işaretlenir (güvenlik ağı kalır).
4. **Boru hattının son kanıtı** (`pipeline-evidence.ts`): toplama, eşleştirme,
   fiyat özeti, zenginleştirme, benzerlik kenarları ve link çözümleme için
   mevcut zaman damgalarından. "Geride olabilir" = beslendiği aşamanın kanıtı
   daha yeni (kesin değil: yeni veri yoksa aşama iz bırakmaz). Takılı koşu
   (2 saat), 24 saatlik feed boşluğu (ops.md §İzleme), 10 dakikadır işlenen ya
   da bekleyen link isteği uyarıdır. İş geçmişi tablosu (`job_run`) yine yok.
5. **Dikkat listesi yalnızca aktif mağazalar** için ve eyleme dönük durumlarla:
   takılı, başarısız, para birimi doğrulanmamış (Shopify), hiç toplanmamış,
   bayat (24 saat ya da mağazanın kendi `refresh_minutes` aralığı). Kısmi koşu
   tek başına durum değildir. Mağaza başına LATERAL tek satır okunur; tüm
   `ingest_run` taranmaz.
6. **Kartlar tıklanabilir**, ama yalnızca izleyicinin rolünün açabildiği sayfaya
   bağlanır; kartların kendisi aynı rollere görünür (moderatör maliyet kartını
   görür ama `/yonetim/islemler`'e bağlantı almaz).
7. **Eşleştirme kararında klavye güvenliği** (`eslestirme/queue-keys.ts`):
   otomatik tekrar (`KeyboardEvent.repeat`) yok sayılır; her karar (tuş ya da
   tık) eşzamanlı, ref tabanlı bir kilitten geçer ve bittikten sonra 400 ms
   yeni karar alınmaz. Önceden React durumuna dayalı koruma, çizimden önce
   gelen ikinci olayda aynı satıra ikinci karar gönderiyor ve sunucunun
   "zaten karara bağlandı" yanıtından sonra SONRAKİ satırı kararsız atlıyordu.
   Sunucunun kilitli işlem ve çakışma korumaları aynen geçerlidir. Onaydan
   sonra ürün özetinin fiyat özeti işiyle güncelleneceği söylenir.
8. **Denetim kaydı "neden"i gösterir**: gerekçe sütunu, aktör ve hedef
   filtresi, hedefin yönetim sayfasına bağlantısı (mağaza, hesap "hesap #id",
   kampanya, sözlük satırı, eşleştirme adayının ürünü). Kişisel veri yok.

## Reddedilen alternatifler

- **Maliyet oranını ekranda hesaplamak** (birim × oran): oran yazım anında
  belirlenir; geriye dönük tahmin gerçek fiyat değildir.
- **`job_run` tablosu:** ertelendi (0039); son kanıt bugünkü ihtiyacı karşılar.
- **Moderatörden maliyet/kullanıcı kartlarını gizlemek:** görünürlük sınırı
  değişikliğidir, bu kararın kapsamı dışında.
- **Kısmi koşuyu dikkat durumu saymak:** tek reddedilen kayıt bile kısmi yapar;
  liste gürültüye boğulurdu.
