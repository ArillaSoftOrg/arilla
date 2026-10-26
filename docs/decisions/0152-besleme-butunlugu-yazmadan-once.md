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
   yazımdan sonra ve `no_deactivate`'te hiç çalışmıyordu; yeni kapı her ikisinde de çalışır. Yalnız `yml`
   (ndjson/toplayıcı beslemeleri taranmaz). **Kapatma ayarı yoktur.**
4. **Karantina kendiliğinden kalkmaz; yalnız açık insan onayıyla kalkar.** Aynı içeriğin tekrar gelmesi,
   süre geçmesi ya da kayıt sayısının artması onay yerine geçmez: kaynak bozuk bir dosyayı tekrar tekrar
   sunuyor olabilir ve otomatik kabul bunu veri olarak yazardı. Meşru küçülme için bkz. §5.
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

## 2b. Meşru küçülme için açık onay (`feeds/approvals.py`)

```
python -m feeds quarantine --feed 7                       # salt okunur: bekleyen karantinalar
python -m feeds approve-drop --feed 7 --snapshot 12 --by ad --reason "..." --confirm
```

- **Dar kapsam:** onay tek beslemenin tek içeriğine (sha256) bağlıdır. Kaynak yeniden güncellenip içerik
  değişirse yeniden karantina; yeni onay gerekir.
- **Sınırlar:** yalnız `too_few_records` ile reddedilmiş, son tam sürümden **sonraki** karantina onaylanır.
  Kesik/boş/okunamayan dosya (`truncated`, `empty`, `unreadable`) onaylanamaz. Gerekçe 15–120, onaylayan
  2–60 karakter. Süre 1–30 gün (varsayılan 7). Aynı içerik için ikinci geçerli onay verilmez.
- **Tek kullanım:** onay bir sürümü kabul ettirir; sonra tükenir. Yarım kalan sürümün kaldığı yerden
  sürmesi serbesttir (aynı sürümde kullanılmış onay geçerlidir). Aynı içerik tekrar küçülürse yeni onay ister.
- **Denetim izi:** `job_run` satırları (yalnız ekleme): `feed_drop_approval` (kim, neden, besleme, sürüm,
  sha256, kayıt, süre) ve `feed_drop_accepted` (hangi onay, hangi sürüm, kayıt, medyan). `job_run`
  180 gün tutulur (0041); uzun süreli kanıt gerekirse karar/PR notuna da yazılmalıdır.
- **`--confirm` olmadan hiçbir şey yazılmaz** (ne onaylanacağı gösterilir).
- **Diğer kapılar atlanmaz:** onay yalnız kayıt sayısı kapısını geçirir. Bütünlük taraması, hata oranı,
  `no_deactivate`, deaktivasyon tavanı (%10) ve 48 saat bekleme aynen çalışır; `no_deactivate`'siz bir
  beslemede onaylı küçük sürüm yazılır ama büyük pasifleştirme tavana takılır (`deactivation_cap`).
- Sonraki senkronizasyon (günde iki kez) aynı içeriği indirince kabul eder; ayrıca müdahale gerekmez.

## 2c. #224'ün testi

#224'teki `test_kesik_deneme_no_deactivate_ve_kapilari_korur` kesik ilk teslimatın ardından gelen **tam
ama %70'lik** (10 → 7) dosyanın başarıyla kabul edilmesini bekliyordu. Bu, bu kararın kapattığı davranıştı
(yazımdan sonra, `no_deactivate`'te boyut kapısı yoktu). Test eşiği gevşetilerek ya da bulunduğu hâlde
değiştirilerek geçirilmedi; yeni davranışı doğrulayacak biçimde yeniden yazıldı: kesik teslimat yeniden
denenir ve sıfır yazar; %70'lik tam dosya karantinaya girer, yeniden denenmez, sıfır yazar; ertesi gün aynı
dosya yine karantinadadır; açık onaydan sonra kabul edilir ve `no_deactivate` ile hiçbir teklif
pasifleşmez. #224'ün asıl amacı (kesik dosya yeniden denenir) eşiğin üstündeki %90'lık dosya için ayrı
testle aynen korunur.

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
- **Aynı içerik tekrar gelince otomatik kabul** (önceki taslak, `drop_confirm_hours`): kaynak bozuk dosyayı
  tekrar sunarsa onu veri yapar ve denetlenebilir bir karar noktası bırakmaz. Açık onaya çevrildi.
- **Besleme başına kapatma ayarı** (`size_guard: false`): denetimsiz bir güvenlik kapısı atlatma yolu. Kaldırıldı.
- **Sabit kayıt eşiği:** katalog meşru olarak küçülebilir; medyana göre oran ve onay yolu kalıcı engeli önler.
- **Tüm XML'i tam doğrulayıcıyla ayrıştırmak:** 0114'ün kaçındığı davranış (tek bozuk karakter = tüm dosya reddi).
