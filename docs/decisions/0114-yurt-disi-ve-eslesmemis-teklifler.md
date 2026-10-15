# 0114 — Yurt dışı teklifleri, eşleşmemiş besleme teklifleri ve production aktarımı

**Tarih:** 14 Ekim 2026
**Durum:** Kabul edildi. 0112 ve 0113'ün TRY dışı gösterim kısıtını kaldırır.

## Karar

1. **`/teklifler`** (ürün kapısı arkasında, `noindex`, robots dışı): iki sekmesi var.
   - **Türkiye'deki mağazalar:** ürünle eşleşmemiş etkin TRY teklifleri. "En uygun
     fiyat" sıralaması var.
   - **Yurt Dışı Teklifleri:** TRY dışı teklifler.
     - Orijinal tutar ve para birimi gösterilir.
     - TCMB kuru 4 günden yeniyse yaklaşık TL, kur tarihiyle verilir.
     - "Kargo ve vergi belirsiz" notu vardır.
     - Toplam fiyat doğrulanmadığı için **fiyat sıralamasına girmez**; en yeni
       görülene göre listelenir.
   - Ürün birleştirmesi yapılmaz. Çözümleyici TRY dışını ürünlere bağlamaz (0112).
2. **Tıklama:**
   - `surface=feed_offers` olarak kaydedilir.
   - AliExpress şablonu `{affiliate_url}&subid={click_id}`. Admitad deeplink API'si
     `rzekl.com/g/<kod>/?subid=..&ulp=..` üretiyor; beslemedeki takip bağlantısı aynı
     host ve yolu kullanıyor (14 Ekim 2026'da doğrulandı).
   - Şablon `feeds ensure-merchant --profile admitad:6115` ile yazılır. Komut
     idempotent; mağaza zaten varsa değiştirmez.
3. **TRY dışı besleme artık etkin mağazaya bağlanabilir.**
   - 30 günden uzun süredir güncellenmeyen besleme etkinleştirilmez; bilerek açmak için
     `--allow-stale` gerekir. Alibaba beslemeleri 2022'den beri güncellenmiyor.
4. **Büyük besleme:**
   - Yeni `feeds` compose servisi (profil `feeds`, yalnız `run --rm`). Besleme RAM
     tabanlı `/tmp`'ye **değil**, diskteki `/opt/arilla/feed-staging`'e iner.
   - Kaynaklar: 1,5 GB bellek, 1 CPU, `/tmp` 64 MB, root değil.
   - İndirme tavanı dinamiktir: boş alan − `FEED_MIN_FREE_BYTES` (20 GiB).
   - Tavanı ya da boş alanı aşan indirme durur ve dosya silinir. Sürüm oluşmaz, hiçbir
     offer pasifleşmez.
5. **İlk production aktarımı:** 10.000 kayıt, örnek kipinde. Kapı `sample_limit`
   olduğu için hiçbir ürün pasifleşmez. 100.000 ve üzeri ayrı onay ister.
