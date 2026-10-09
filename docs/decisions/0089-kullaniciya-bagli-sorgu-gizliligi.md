# 0089 — Kullanıcıya bağlı arama metni: kişisel, kimlik/sır ve özel nitelikli veri saklanmaz

**Tarih:** 9 Ekim 2026 · **Durum:** kabul edildi (karar 0049 §7 ve 0054'ün tamamlayıcısı)

## Karar

1. **Kişiye bağlı sorgu deposu en dar süzgeci kullanır.** `user_activity_event.query_norm`
   yalnızca `isActivityQueryStorable` geçerse yazılır:
   `isSearchQualityRecordable` (e-posta, telefon, adres, URL, uzun rakam, bölünmüş kimlik,
   sır benzeri ifade) **ve** `sensitiveCategory` boş (KVKK m.6: sağlık, gebelik, engellilik,
   din, siyasi görüş, cinsel hayat, genetik/biyometrik, ceza mahkûmiyeti, sendika).
2. **Olay yine yazılır, metin yazılmaz.** Süzgeçten geçmeyen aramada `search_submitted`
   olayı, sonuç sayısı ve sayaçlar korunur; `query_norm` NULL kalır. Şema zaten izin verir;
   migration yok.
3. **Tekrar bastırma NULL-güvenlidir** (`IS NOT DISTINCT FROM`). Metni saklanmayan
   aramalar 10 dakikalık pencerede birbirinin tekrarı sayılır; bilinçli küçük az sayım.
4. **Kimliksiz özet bilerek daha dar süzgeç kullanır.** `search_query_day` (0054) kişiye
   bağlı değildir; özel nitelikli alışveriş sorguları ("hamile pantolonu", "yetişkin bezi")
   sözlük boşluklarını görmek için orada kalır. Yalnızca kişisel veri ve kimlik/sır
   benzeri metin süzülür.
5. **Kurallar tek yerde.** Yeni düzenli ifade yazılmaz: `query-privacy.ts`,
   `isRecordableQuery` ve `sensitiveCategory` birleştirilir.

## Gerekçe

Veri en aza indirme. Arama metni bu tabloda hesap kimliğiyle yan yana durur ve yönetim
kullanıcı detayında okunur. Analitik çerez rızası, özel nitelikli verinin kişiye bağlı
işlenmesi için açık rıza yerine geçmez; ürüne de gerekmez (sayaçlar metinsiz çalışır;
metni saklanmayan arama son aramalar listesinde görünmez). Kimliksiz özette aynı metin kişiyle ilişkilendirilemez, kalite ölçümü
için değerlidir.

## Reddedilen alternatifler

- **Olayı hiç yazmamak:** arama sayacı ve son arama zamanı bozulur, rızalı analitik eksik kalır.
- **Metni karartmak (redaksiyon):** yeni kurallar gerekir, kalan metin anlamsızdır.
- **Ayrı son-aramalar deposu / yalnızca tarayıcıda tutmak:** rıza, saklama, dışa aktarma ve
  silme bu tabloda zaten var; tarayıcı deposuna bağlı akış kurulmaz (CLAUDE.md).
- **Tam `queryContentIneligibility`:** modele giden metnin uzunluk sınırları (2–120) bu
  depo için gereksiz.

## Sınırlar

Süzgeç kapsamlı değildir: ad-soyad, dolaylı anlatım, yazım hatası kaçabilir. Mevcut
satırlar 90 günlük NULL'a çekme ile temizlenir; daha hızlı geriye dönük temizlik ayrı iştir.
