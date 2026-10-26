# 0152 — Besleme bütünlüğü yazmadan önce doğrulanır (kesik dosya, anormal düşüş)

**Tarih:** 26 Ekim 2026
**Durum:** Önerildi (PR). Birleştirme ve dağıtım kullanıcı onayına bağlıdır; üretim verisine
dokunulmadı (yalnız salt okunur sorgular). Migration yok.
**İlişkili:** 0112 (senkronizasyon), 0114 (ilk yükleme, bozuk kayıt), 0117 (`no_deactivate`), 0145 (günlük tazeleme)

## 1. Olay

26 Ekim 2026 06:33 UTC, `feed_daily` koşusu `partial` bitti, `arilla-feeds-daily.service` `failed` oldu.
Besleme 7 (AliExpress) belgenin yaklaşık %34'ünde, kapanış etiketi olmadan bitti:

| | Önceki tam sürüm (7) | Kesik sürüm (8) |
| --- | --- | --- |
| Bayt | 760.733.905 | 256.926.808 |
| Kayıt | 2.662.361 | 896.842 |
| Bayt/kayıt | ~286 | ~286 |

İndirme katmanı hata vermedi (gzip akışı kendi içinde tamamdı), kesiklik ancak ayrıştırma sonunda
(`EOFError: besleme kapanis etiketi olmadan bitti`) görüldü. O zamana kadar 896.842 kayıt **yazılmıştı**:
107.190 yeni teklif, 156.145 güncelleme, 262.448 fiyat noktası. Sürüm `rejected` oldu, hiçbir teklif
pasifleşmedi (`no_deactivate`), ama kısmi yazım kaldı ve `offers_stale: 3.753.373` raporlandı. Kesikliğin
kaynağı (Admitad ya da ara katman) doğrulanamadı: HTTP başlıkları kaydedilmiyordu.

Kök neden **tasarım boşluğu**: tamlık kapısı (`_gate`) yazımdan SONRA çalışıyordu; `no_deactivate` açık
beslemelerde boyut karşılaştırması hiç yapılmıyordu; `truncated` yeniden denenmiyordu.

## 2. Karar

1. **Yazmadan önce tarama** (`feeds/integrity.py`). Dosya, hiçbir satır yazılmadan, sıkıştırması
   çözülerek 1 MiB bloklarla tek geçişte taranır: sıkıştırılmış akış kesintisiz bitmeli, her `<offer>`
   için bir `</offer>` olmalı, son kayıttan sonra kapanış etiketi (`</offers>`/`</yml_catalog>`) gelmeli,
   en az bir kayıt olmalı. Bellek: blok + 64 KiB kuyruk; dosya RAM'e yüklenmez, diske ek yer gerekmez.
   Ölçüm: 600.000 kayıt / 529 MB çözülmüş içerik 1,9 sn (~280 MB/sn). Gerçek besleme (~2,7 GB çözülmüş)
   için tahmini 10–20 sn.
2. **Kayıt düzeyi bozukluk denetlenmez.** Karar 0114: tek bozuk karakter dosyayı durdurmamalı; bu
   `ingest_error` ve `max_reject_ratio` kapısında kalır. "Gerçek XML bütünlüğü" yapısal tamlıktır.
3. **Anormal düşüş karantinası.** Dosyadaki tam kayıt sayısı son 3 tam sürümün medyanının
   `min_ratio_vs_median`'inin (%85) altındaysa sürüm `rejected` (`too_few_records`), yazım yok. Eski kapı
   yazımdan sonra ve `no_deactivate`'te hiç çalışmıyordu; yeni kapı her ikisinde de çalışır.
   `size_guard: false` besleme ayarıyla kapatılabilir (varsayılan açık; yalnız `yml`).
4. **Meşru küçülme kalıcı engellenmez.** Aynı içerik (aynı sha256) `drop_confirm_hours` (6 saat,
   ayarlanabilir) önce de karantinaya alındıysa kaynak değişmemiştir: kabul edilir (`drop_confirmed`).
   Günde iki tetik (06:30, 18:30) olduğundan bir sonraki koşuda kendiliğinden olur. İçerik her seferinde
   değişen kesik dosya bu yoldan geçemez; üstelik kesik dosya 2. maddede zaten elenir.
5. **`truncated` yeniden denenir** (main'deki #224 ile birleşik: orada kesik dosya yazıldıktan sonra yeniden deneniyordu, burada yazmadan önce). `DownloadError('truncated'|'corrupt')` artık `retryable`; yazmadan
   önceki kapı `truncated` derse günlük iş aynı koşuda 10 ve 20 dk arayla yeniden indirir, `ingest_run`
   `next_retry_at` yazar. `too_few_records` koşu içinde yeniden denenmez (aynı içerik gelir).
6. **HTTP tanılama.** İndirme yanıtından izin listeli başlıklar (`content-length`, `content-encoding`,
   `etag`, `last-modified`, …), durum, yönlendirme sayısı, yalnızca **host**, bayt ve gzip tamlığı
   `ingest_run.checkpoint` içine yazılır. Adres, sorgu, kimlik, `Set-Cookie`, `Location`, `Authorization`
   kaydedilmez; adres/anahtar gibi görünen değerler atılır. Ayrıca `Content-Length` ile alınan bayt
   uyuşmazlığı `truncated` sayılır.
7. **Tazelik ve rapor.** `last_success_at` yalnız tam sürümle ilerler (değişmedi). Rapor artık nedeni
   gösterir: `feeds_rejected`, `rejected_reasons`, `offers_in_rejected` (eski akışta reddedilen sürüme
   yazılmış teklifler), `offers_missing_from_latest` (son tam sürümde olmayan teklifler).

Korunanlar: `no_deactivate`, 48 saat bekleme ve %10 tavan, `price_point` yalnız INSERT, ilk yükleme
aşama kapıları, `--max-records` örnek kipi (taranmaz), ndjson/toplayıcı beslemeleri (taranmaz), başarılı
beslemenin davranışı ve sayıları.

## 3. 845.506 eski teklif (yalnız inceleme; hiçbir şey değiştirilmedi)

Üretim, 26 Ekim 17:50 UTC, salt okunur: `feed_source_offer` besleme 7'de üç grup:

| Grup (son görüldüğü sürüm) | Teklif | Etkin | Ürüne bağlı | Fiyat bandı | `last_changed_at` |
| --- | --- | --- | --- | --- | --- |
| Yalnız 15 Ekim sürümü (4) | **845.506** | 845.506 | 836.854 | 10–25 USD (medyan 16,83) | 14–15 Ekim |
| 25 Ekim sürümü (7) | 2.011.025 | 2.011.025 | 1.331.208 | 10–25 USD (16,58) | ≤ 25 Ekim |
| Kesik 26 Ekim sürümü (8) | 896.842 | 896.842 | 601.416 | 10–25 USD (16,45) | ≤ 26 Ekim |

- Hepsi aynı fiyat bandında: bu bir **bant geçişi değil**. 15 → 25 Ekim arasında 846.979 yeni teklif
  eklendi, 845.506 teklif kaynaktan çıktı (~%30 dönüş).
- 845.506 teklif 11 gündür **etkin ve stokta** görünüyor; 15 Ekim'den beri fiyat noktası yok.
  836.854'ü bir ürüne bağlı; ürün sayfalarında bayat fiyatla görünüyor olabilirler.
- Pasifleşmemelerinin nedeni: besleme 7 `no_deactivate: true`. 25 Ekim 12:10 koşusu `deactivation_cap`
  ile durmuştu (bu ayar o zaman yoktu ya da sonradan eklendi; geçmiş doğrulanamadı).
- Kaynaktan gerçekten kalktıkları mı, yoksa Admitad'in her sürümde farklı bir alt küme mi verdiği bu
  incelemeyle ayırt edilemedi. Kanıt için tek tek ürün sayfası yoklanmadı (kazıma yok).

**Bu PR bu tekliflere dokunmaz** (silme/pasifleştirme yok). Yalnız görünür kılar:
`offers_missing_from_latest`. Ne yapılacağı (okuma yolunda "bayat" etiketi, `no_deactivate` yerine
bekleme süreli pasifleştirme, ya da doğrulamayla) ayrı ürün/veri kararıdır.

## 4. Reddedilen alternatifler

- **Kesikliği yazımdan sonra geri almak** (satırları silmek): `price_point` yalnız INSERT; silme yolu açmak
  ya da geri alma mantığı yazmak sağlam değil. Yazmamak daha basit ve güvenli.
- **Sürümü önce geçici tabloya yüklemek:** milyonluk kayıt için çift yazım, WAL ve disk maliyeti (0134).
- **Sabit kayıt eşiği:** katalog meşru olarak küçülebilir; medyana göre oran ve onay yolu kalıcı engeli önler.
- **Tüm XML'i tam doğrulayıcıyla ayrıştırmak:** 0114'ün kaçındığı davranış (tek bozuk karakter = tüm dosya reddi).
