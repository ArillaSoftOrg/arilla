# 0217 — Kütüphane: aramalarda öne çıkan ürünlerin kişisel vitrini

**Karar.** Kütüphane arama veya sohbet geçmişi DEĞİLDİR. Kullanıcının başarılı metin aramalarında
(`outcome.mode = "results"`, ilk sayfa, yeni arama, varsayılan `balanced` sıralama) üst sıradaki 3 gerçek
katalog ürünü `library_item (user_id, product_id)` tablosuna aday olarak yazılır. Saklanan tek şey kullanıcı-ürün
ilişkisidir: ilk eklenme, son öne çıkma zamanı, en iyi sıra (1-3) ve sayaç. Sorgu metni, niyet, sohbet kimliği,
başlık, görsel, fiyat ve kategori SAKLANMAZ; okurken güncel `product`/`category`/`brand` verisinden gelir.

- **Rıza:** `user_consent.kind = 'personalization'` (yeni hesapta varsayılan açık, karar 0060). Rıza yoksa
  yazılmaz; yeni rıza türü eklenmedi.
- **Saklama:** kullanıcı başına en çok 60 satır (en eski `last_surfaced_at` düşer), 180 gün (`cleanup-auth`),
  hesap ya da ürün silinince `ON DELETE CASCADE`. Kullanıcı tek satırı siler ya da tümünü temizler.
- **Hariç:** `is_discoverable = FALSE` kategoriler (iç giyim, sağlık vb.) hem yazımda hem okumada dışlanır.
- **Bağımsızlık:** `product_view` (/gecmis) ve `saved_item` (Kaydettiklerim) ile hiçbir veri ortak değil.
- **Kapsam dışı (ilk sürüm):** sohbet önerileri (render sırasında yazma ve yenileme gürültüsü riski); internet
  arama sonuçları (katalog verisi değildir, kalıcı saklanamaz, karar 0102); fallback/yakın sonuçlar.
- **Okuma:** `GET /api/kutuphane` (oturumdan `user_id`, `private, no-store`), menü açılınca çağrılır; keyset
  sayfalama `(last_surfaced_at, product_id)`. Kategori çipleri kullanıcının satırlarındaki ana kategorilerden
  türetilir. Fiyat yalnızca stokta ise `product.min_price`'tan gösterilir.
- **Yazma yolu:** arama yanıtından sonra `after()` içinde; hata aramayı bozmaz, arama/ranking koduna dokunulmaz.

**Gerekçe.** Kişiselleştirilmiş vitrin için sorgu metni gerekmez; ilişki yeter. Katalog verisini kopyalamak
fiyat/başlığı bayatlatırdı. Analitik olay tablosu rıza ve 90 gün NULL kuralı nedeniyle uygun değildi.

**Reddedilen.** `user_search_history` (sorgu metni = gereksiz kişisel veri); `user_activity_event` yeniden
kullanımı (analitik rızasına bağlı olur); ürün başlığı/görsel/kategori kopyası (bayatlar); sohbet render'ında yazma.
