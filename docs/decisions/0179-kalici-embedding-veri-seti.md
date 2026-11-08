# 0179 — Kalıcı embedding veri seti (`embedding_dataset`)

Durum: **kabul**. Migration 0109. İlgili: 0177 (ürün metin vektörü), 0178 (gölge ölçüm),
kural 3 (her AI çıktısı saklanır), kural 4 kalıbı (yalnız ekleme).

## Bağlam

- `product_text_embedding` (0105) ürünün **güncel** vektörüdür: ürün silinince FK ile gider, başlık
  değişince üstüne yazılır ve kanonik metni saklamaz. Parası ödenmiş (metin, vektör) çiftleri bu
  yüzden zamanla kaybolur.
- Hedef: ileride kendi modelimizi eğitmek/damıtmak. Bunun için sağlayıcıdan alınan her çiftin
  ürünün yaşam döngüsünden bağımsız ve kalıcı olarak saklanması gerekir.

## Karar

1. **Tablo `embedding_dataset`** (0109): anahtar `(model_version, content_hash)`; kanonik metin
   (`input_text`), `halfvec(768)` vektör, `text_version`, sağlayıcı görevi (`task`),
   kaynak (`api` | `backfill`), `first_product_id` (yalnız iz, **FK yok**), `created_at`.
2. **Yalnız ekleme:** `arilla_app` UPDATE/DELETE/TRUNCATE yapamaz (veritabanı yetkisi; testli).
   Aynı kanonik metin tek satırdır: tekrar eden metin yer kaplamaz.
3. **Yazım:** `enrich.products` her başarılı API sonucunu vektör yazımıyla **aynı işlemde**
   arşive ekler (ek API maliyeti yok); API'siz kopya ve yalnız-özet güncellemeleri yeni satır
   üretmez. `python -m enrich.dataset --execute` 0179'dan önceki vektörleri, kanonik metni güncel
   başlık/markadan yeniden kurup **özet eşleşirse** arşive kopyalar; metni sonradan değişmiş ürün
   atlanır (yanlış metin-vektör çifti girmez).
4. **Kapsam:** yalnızca katalog metni (kişisel veri değil). Kullanıcı sorgu metni ve sorgu
   vektörleri bu tabloya **yazılmaz** (KVKK; 0178).
5. **Koruma:** üretim yedekleri (pgBackRest + R2, karar 0110) tabloyu kapsar. Nesne deposuna
   ayrı dışa aktarım (Parquet) tam katalog yüklemesinden önce ayrıca değerlendirilir.

## Maliyet

Satır başına ~1,6 KB (vektör) + metin (~130 bayt). 100 bin ürün ≈ 0,2 GB; 12 M ürün ≈ 20 GB
(**tahmin**). Tam katalog yüklemesinde disk bütçesi (0177: 99 GB boş) birlikte planlanır.

## Açık nokta

Sağlayıcı (Jina) kullanım şartlarının, çıktıların kendi modelimizi eğitmek için kullanımına izin
verip vermediği **doğrulanmadı**; eğitimden önce hukuki olarak kontrol edilmelidir. Saklamak bu
kontrolü beklemez.

## Reddedilen alternatifler

- **`product_text_embedding`'e metin kolonu eklemek:** ürün silinince yine gider, üstüne yazılır.
- **Yalnızca dosyaya dışa aktarmak:** işlem bütünlüğü yok; vektör yazılıp dosya yazılamayabilir.
