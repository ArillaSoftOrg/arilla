# 0016 — Embedding üretimi: satır başına offer, çağrı başına farklı içerik

**Tarih:** 2026-09 · **Durum:** kabul edildi

Sağlayıcı kararı `0015`'te. Bu dosya o sağlayıcının **nasıl kullanıldığına**
dair üç kararı kaydeder.

## Karar

1. **Her offer bir `embedding` satırı alır; her farklı içerik bir API çağrısı
   üretir.** Aynı görsel yüz offer'da geçse bile sağlayıcıya bir kez gider.
2. **Zenginleştirme `ingest_run` yazmaz.** Kendini `api_usage` ve log
   üzerinden raporlar.
3. **Maliyet token cinsinden ölçülür, fiyat sonradan bağlanır.**
   `api_usage.units` sağlayıcının döndüğü token sayısını tutar;
   `cost_micros`, `EMBEDDING_COST_MICROS_PER_1K_TOKENS` ile hesaplanır ve o
   değişken gerçek fiyat bilinene kadar `0`'dır.

## Gerekçe

**Neden satır başına offer.** Şema `embedding_uniq (target_type, target_id,
kind, model_version)` diyor ve `embedding_ann_idx` HNSW indeksi
`WHERE target_type = 'offer'`. Görsel arama offer embedding'leri üzerinden
gidiyor; her offer'ın kendi satırı olmazsa aramada görünmez. Vektörün
paylaşılması satırın paylaşılmasını gerektirmiyor.

**Neden çağrı başına farklı içerik.** Pahalı olan satır değil, model çağrısı.
Tohum kataloğunda 400 offer 8 farklı görsele işaret ediyor: 400 satır yazıldı,
sağlayıcıya 8 görsel gitti. `CLAUDE.md` 3. kuralın ("her AI çıktısı saklanır,
maliyet katalog büyüklüğüyle ölçeklenir") pratikteki karşılığı bu. Yineleme
hem koşu içinde (aynı hash) hem koşular arasında (veritabanındaki önceki
vektör) çalışır.

**Neden `ingest_run` yok.** `ingest_run.merchant_id` NOT NULL ve tablo
`architecture.md` §1'e (Toplama) ait. Zenginleştirme merchant sınırından
bağımsız çalışır, bir koşuda birden çok mağazanın offer'ına dokunur. Uydurma
bir `merchant_id` yazmak tabloyu kirletirdi. Bunun yerine boru hattı isteğe
bağlı bir `merchant_id` **filtresi** kabul eder — "şu mağazayı yeniden
embedding'le" işletimde gereken bir işlem.

**Neden maliyet sıfır yazılıyor.** Sağlayıcı hesabı henüz açılmadı, gerçek
fiyat bilinmiyor. Uydurulmuş bir fiyat yazmak `docs/ops.md`'nin maliyet
raporunu yanlış besler. Token sayısı gerçek ve kayıtlı; fiyat belli olunca
`cost_micros` geriye dönük hesaplanabilir. **Sıfır maliyet "maliyet yok"
demek değildir**, "fiyat henüz bağlanmadı" demektir.

## Uygulama sırasında bulunan hata: yetim embedding'ler

`embedding.target_id` ve `generated_content.target_id` **kasıtlı olarak
foreign key değil** — polimorfik (`offer` / `product` / `query`). Bunun
görülmemiş bir bedeli vardı: `pnpm seed`'in
`TRUNCATE ... RESTART IDENTITY CASCADE` çağrısı bu iki tabloya **dokunmuyordu**
(CASCADE yalnızca FK üzerinden yürür), ama `RESTART IDENTITY` yeni offer'lara
aynı ID'leri veriyordu.

Sonuç: eski koşudan kalan vektörler sessizce **başka ürünlere** yapışıyordu.
Tohum verisi deterministik olduğu için bu oturumda tesadüfen doğru eşleşti;
gerçek veride sessiz yanlış eşleşme olurdu — ve sessiz yanlış veri, eksik
veriden kötüdür.

Düzeltme: `embedding` ve `generated_content` tohumun TRUNCATE listesine
eklendi. FK olmayan her polimorfik hedef için aynı dikkat gerekir.

## Reddedilen alternatifler

- **Görsel başına tek satır, offer'lar hash üzerinden çözümlensin.** HNSW
  indeksi `target_type = 'offer'` üzerinde; aramanın her offer için satır
  bulması gerekiyor. Şemayı değiştirmeye değmez.
- **Yineleme isabetleri için de `api_usage` satırı.** `cache_hit` kolonu bunu
  davet ediyor ama bir koşuda 392 satır üretirdi. İstek yolundaki görsel arama
  için anlamlı (kullanıcı başına ölçüm), toplu iş için gürültü. Yineleme
  sayısı koşu çıktısında raporlanıyor.
- **Zenginleştirmeye sahte bir `merchant_id` ile `ingest_run` yazmak.**
  Tabloyu anlamsızlaştırırdı.

## Sonucu

- `python -m enrich --kind both [--limit N] [--fake-client]`
- `--fake-client` deterministik, normalize vektör üretir; API anahtarı
  gerektirmez. **Vektörler anlamsal değildir**, CLI bunu her koşuda uyarır.
- İndirilen görsel baytı hiçbir yere yazılmaz; kalıcı olan yalnızca
  `offer.image_hash` ve vektör.
- Gerçek API yolu yazıldı ama **çalıştırılmadı** — anahtar gelince
  `--fake-client` düşürülerek doğrulanacak; yanıt alan adları o zaman teyit
  edilecek (`0015`, açık maddeler).
