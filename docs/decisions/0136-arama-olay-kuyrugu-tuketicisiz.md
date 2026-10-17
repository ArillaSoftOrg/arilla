# 0136 — Arama olay kuyruğu (search_outbox) tüketicisiz kalır; arama PostgreSQL'i doğrudan okur

**Tarih:** 18 Ekim 2026
**Durum:** Önerildi (PR). 0111'in "harici arama motoru gelince tüketici eklenir" notunu netleştirir.

## Sorun

Üretimde `search_outbox` 5.572.716 kayıt; `processed_at` dolu satır **0**, en eski işlenmemiş olay
14 Ekim 2026. Bu bir kuyruk tıkanması gibi görünüyor.

## Bulgular (kod ve ölçümle doğrulandı)

1. **Üreticiler:** `catalog_build/publish.py` (yayınlanan her ürün için `source_listing_published`),
   `feeds/sync.py` (teklif eklendi/yeniden etkinleşti/parmak izi değişti: `feed_*`; besleme dışı
   kalan teklif: `delete/feed_missing`). Üretimdeki ~5,57 M ≈ 2,77 M yayın + ~2,8 M teklif eklemesi.
2. **Tüketici yok:** depoda `processed_at`'i yazan, `search_outbox`'ı okuyan hiçbir kod, worker,
   cron ya da systemd birimi yok. 0065/0111 tabloyu "harici arama motoru gelince" için ayırmıştı.
   VPS `catalog-publish` betiği outbox sayısını yalnızca yayın doğrulaması için okur.
3. **Arama outbox'a bağlı değil:** `/ara`, `/ara/gorsel`, `/ara/link` ve `/sohbet` doğrudan
   `product`/`offer` tablolarını okur; PostgreSQL indeksleri (`product_title_fold_*_trgm`, 0083)
   yazımla aynı işlemde günceldir. Yerel 1,04 M ürünlük katalogda (1 M yalnız USD teklifli
   AliExpress benzeri) yeni yayınlanan ürün aynı anda aramada bulunur:
   - `/ara` 33 sorgu: p50 94 ms, p95 887 ms (geçici yükte en kötü 3,6 sn; tekrar ölçümde ≤ 1,2 sn).
   - Sohbet (`searchByIntent`, 4 sn sınırı) 10 sorgu: p50 485 ms, p95 1,1 sn; zaman aşımı yok.

Yani %0 işlenmiş olması bir arıza değil, tüketicinin hiç yazılmamış olmasıdır; arama, sohbet ve
ürün erişimi bundan etkilenmez.

## Karar

1. **Tüketici/indeksleme servisi yazılmaz.** İşleyecek harici bir hedef yok; boş bir tüketici
   satırları "işlendi" diye işaretlemekten başka bir iş yapmazdı (yanlış sinyal).
2. **Üreticiler korunur.** Kayıtlar yayın doğrulamasında kullanılıyor ve ileride harici arama
   motorunun ilk doldurma sonrası artımlı değişim kaynağıdır.
3. **Kayıt silinmez, işlenmiş işaretlenmez.** Saklama/sıkıştırma (ör. aynı varlığın eski olaylarını
   kaldırmak) ayrı bir karardır; harici motor kararıyla birlikte verilir.
4. **Görünürlük:** `pnpm db:health` salt okunur rapora "Arama indeksi olay kuyruğu" bölümü eklenir:
   toplam (tahmin), işlenmemiş (kısmi indeksten tam sayım), boyut, en eski olayın yaşı ve "tüketici
   yok" notu. Yönetim kapsam kaydında sinyal `unmeasured` → `data_no_ui`.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Outbox'ı işleyen worker | Hedef yok; arama doğrudan PostgreSQL; gereksiz servis ve yük |
| Satırları `processed_at = now()` ile kapatmak | İşlenmeden işlendi demek; gelecekteki tüketici için veri kaybı |
| Üretimi kapatmak | Yayın doğrulaması (`catalog-publish`) bozulur; gelecekteki değişim kaynağı kaybolur |
| Toplu silme | Geri alınamaz; saklama kuralı henüz kararlaştırılmadı |

## Sonuçlar

- Maliyet: satır başına küçük bir ekleme (ürün yazımının WAL'i yanında ihmal edilebilir) ve
  kısmi `search_outbox_pending_idx` tüm satırları taşır. Büyüme yayın/besleme değişimiyle orantılı.
- Harici arama motoru gündeme gelirse: ilk doldurma tablolardan, sonrası bu kuyruktan; o kararda
  tüketici (artımlı, yeniden başlatılabilir, idempotent) ve saklama birlikte tasarlanır.
- Bilinçli kapsam dışı (0129 madde 6, değişmedi): link araması aday üretimi, mağaza karşılaştırma
  ve internet sonucu katalog görseli TRY-only; yalnız USD teklifli AliExpress ürünleri orada yoktur.
