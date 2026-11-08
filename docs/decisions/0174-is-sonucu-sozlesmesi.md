# 0174 — Arka plan iş sonucu sözleşmesi (`job_run.detail.outcome`)

Durum: **kabul (PR1a)**. Şema değişmez; migration yok. Üretime alınması ayrıca değerlendirilir
(bkz. "Dağıtım politikası").

## Bağlam

`job_run.status` (`success` / `partial` / `failed`, karar 0055) yalnızca işin teknik olarak
nasıl bittiğini söyler. "Ne üretti?" sorusunu cevaplamaz:

- 8 Kasım üretim `resolve` koşusu (job_run 885) `success`, `considered = 0`: işlenecek teklif
  yoktu. Arıza değil, ama "çalıştı ve bağladı" ile aynı görünür.
- Aynı gece `similarity_edges` (886) `success`, `visual_products = semantic_products = 0`:
  bağlı ürün var, offer embedding'i yok. Kenar üretilmedi; yine `success`.
- Kilit meşgulken `resolve` hata dizisine metin ekleyip `partial`/çıkış 1 veriyordu: bekleyen
  bir koşu, teklif hatasıyla aynı sayaçtaydı.

## Karar

1. Sonuç `job_run.detail` içinde iki alanla raporlanır: `outcome` ve isteğe bağlı `reason`
   (`^[a-z][a-z0-9_]{1,39}$`). `status` değerleri ve şema değişmez.
2. Sözleşme (`services/ingest/db/job_run.py` `OUTCOMES`):

   | outcome | status | çıkış | reason (resolve / similarity) |
   |---|---|---|---|
   | `completed` | success | 0 | — |
   | `no_input` | success | 0 | `no_eligible_offers` / `no_eligible_products` |
   | `skipped_locked` | partial | 75 | `lock_busy` |
   | `partial` | partial | 1 | `offer_errors` |
   | `failed` | failed | 1 | `exception` / `invalid_outcome` |
   | `blocked_upstream` | partial | 0 | `no_embeddings` |

   75 = `EX_TEMPFAIL`: bu koşu hiçbir şeye dokunmadı.
3. **`completed` ne demektir, ne demez.** İş tanımlı işlem akışını sonuna kadar koşturdu. Yeni
   kayıt üretildiğini **garanti etmez**: `resolve`'da tüm adaylar insan kuyruğuna düşebilir ya
   da `--no-create` ile hiçbir şey açılmayabilir; `similarity`'de kenarlar taban skorunun altında
   kalabilir. `similarity`'de bir türde (görsel ya da metin) embedding bulunması `completed`
   için yeterlidir; **diğer türün eksiksiz olduğu anlamına gelmez**. Üretilen miktar ve tür
   bazlı eksiklik işin kendi sayaçlarından okunur (`products_created`, `auto_accepted`,
   `visual_edges`, `semantic_edges`, `visual_products`, `semantic_products`, …).
4. Sözleşmeye katılım açıktır: `job_run.track(job, outcomes=True)`. Bugün yalnızca `resolve` ve
   `similarity` katılır. Katılmayan işler (collect, enrich, …) kayıt biçimini aynen korur.
   Katılan işte istisna her zaman `failed`/`exception` yazar ve istisnayı yeniden fırlatır;
   açık sonuç verilmezse `status`'tan türetilir.
5. Geçersiz sonuç adı **arıza** sayılır (`failed`/`invalid_outcome`, çıkış 1): programlama
   hatası alarmı susturmasın. Geçersiz gerekçe yazılmaz, sonuç korunur.
6. `outcome`/`reason` detail'in başına konur; `bounded_detail` sınıra gelince sondan atar, sonuç
   kalır. Mevcut alanlar silinmez.
7. Sonuç yalnızca tipli sayaçlardan üretilir, hata metni ayrıştırılmaz:
   - `resolve`: `ResolveCounts.skipped_locked` (yeni; kilit artık `errors`'a yazılmaz) >
     `errors` > `considered == 0` > `completed`. `link_conflicts` (PR #289) hata değildir.
   - `similarity --edges`: iki türde de vektörlü ürün 0 ise tek bir `EXISTS` (bağlı aktif
     teklif var mı) sorulur; normal koşuda ek sorgu yoktur. Var → `blocked_upstream`;
     yok → `no_input`. Bir türde vektör varsa `completed` (madde 3).
   - `similarity` kilidi (PR1a.1): `SimilarityCounts.skipped_locked` her şeyin önündedir.
     Kenar kilidi (`EDGE_LOCK_KEY`) iki tür için koşunun başında bir kez alınır; meşgulse
     hiçbir şey yazılmaz ve `skipped_locked`/`lock_busy`, çıkış 75 (önceden `RuntimeError` →
     `failed`/1). Birleşik koşuda fiyat adımı da atlanır.
   - **Birleşik `similarity` (kenar + fiyat) tek sonuç yazar; sonuç kenar adımındandır.** Fiyat
     adımının kendine özgü "girdi yok/engellendi" durumu yoktur. Kenar engellenince koşunun
     `partial`/`blocked_upstream` olması doğrudur: tanımlı çıktının bir kısmı üretilemedi.
     Fiyat adımının koştuğu `price_*` sayaçlarından okunur; panel fiyat aşamasını bu koşudan
     bayat saymaz (PR1b). Ayrı sonuç alanı ya da yeni sonuç adı eklenmedi (sözleşme değişmez).
   - `similarity --limit N` için N ≥ 1 (PR1a.1). `--limit 0` hiçbir ürünü işlemeden vektörlü
     ürünü 0 gösterip yanlış `blocked_upstream` yazıyordu; artık argüman hatasıdır (çıkış 2,
     koşu kaydı yok).
8. Dry-run iş kaydı bırakmaz (karar 0055); çıkış kodu aynı sözleşmeden gelir.

## Mimari notlar

- **İki yazıcı.** `job_run` tablosuna TypeScript tarafı da ayrı bir yazıcıyla yazar
  (`packages/core/src/ops/job-run.ts`, `/api/cron/*` uçları). İki taraf birbirini çağırmaz.
  Bu karar yalnızca Python yazıcısını kapsar; TypeScript işleri `detail.outcome` yazmaz.
  Okuyucular (panel, alarm) `outcome` alanının **olmamasını** "eski biçim" olarak ele almalıdır,
  arıza olarak değil.
- **PR1b (panel).** `no_input` "Çalıştı — Uygun girdi bulunamadı" olarak gösterilir.
  `skipped_locked` ve `blocked_upstream` iş üretmiş ya da güncel veri oluşturmuş gibi
  **gösterilmez**: "son başarılı koşu"/tazelik kanıtı sayılmaz.
- **PR2-C.** Ara commit'li bir işin yarıda kalması (`partial_commit`: bir kısmı kalıcı yazıldı,
  sonra hata) bu sözleşmede ayrı bir sonuç değildir; bugün istisna yolu `failed` yazar. PR2-C'de
  ayrıca değerlendirilir; `OUTCOMES`'a eklenmesi yeni bir karar gerektirir.

## Geçiş sürecindeki sınırlamalar

- **Panel — kapandı (PR1b, #296).** Panel `outcome`'u okur: "son başarılı" yalnızca
  `completed`/`no_input`/`partial` (eski kayıtta `success`/`partial`), `skipped_locked` ve
  `blocked_upstream` tazelik sayılmaz, "son çıktı" yalnızca doğrulanmış sayaçlardan gelir,
  atlanan koşu gecikme hesabını sıfırlamaz. PR1b'den önce bu iki sonuç (`partial`) "son iyi
  koşu" görünüyordu. Ayrıntı: `docs/ops.md` "İş sonucu — geçiş notları".
- **Alarm — kapandı (PR1c).** `arilla-alert@` ve 5 dakikalık sağlık kontrolü gece katalog
  hattının başarısızlığını çıkış kodu **ve** o koşunun `outcome`'uyla sınıflandırır; ayrıntı
  aşağıda "PR1c — uygulama".

## systemd

`arilla-catalog-pipeline.service` (`Type=oneshot`, `OnFailure=arilla-alert@%n`) iki
`ExecStart` çalıştırır: `resolve --limit 5000`, ardından `similarity --edges`. Sıfırdan farklı
çıkış birimi başarısız sayar, sonraki `ExecStart` çalışmaz ve alarm tetiklenir.
`SuccessExitStatus` tanımlı değildir.

**Mevcut ve yeni davranış farkı (abartısız):**

| durum | bugün | PR1a ile |
|---|---|---|
| kilit meşgul | çıkış 1, alarm, similarity çalışmaz | çıkış 75, alarm, similarity çalışmaz |
| kenar kilidi meşgul (similarity, PR1a.1) | çıkış 1 (`failed`), alarm | çıkış 75 (`skipped_locked`), alarm |
| teklif hatası | çıkış 1, alarm | aynı |
| girdi yok | çıkış 0 | aynı |
| embedding yok (similarity) | çıkış 0, `success` | çıkış 0, `partial`/`blocked_upstream` |

Yani systemd ve alarm açısından gözle görülür tek fark, kilit meşgulken çıkış kodunun 1 yerine
75 olmasıdır. Birim yine başarısız sayılır. Embedding eksikliği bugün de alarm üretmiyordu;
PR1a ile de üretmez, yalnızca `job_run`'da görünür hâle gelir.

**`blocked_upstream` çıkış 0 neden güvenli:** `similarity --edges` zincirin son adımıdır ve bu
birime `After=`/`Requires=` ile bağlı başka birim yoktur (`catalog-auto-guard` yalnızca
`is-active` okur). Zincire bu adımdan sonra adım eklenirse karar yeniden değerlendirilir.

**PR1c için kısıtlar:**

1. **`SuccessExitStatus=75` tek başına güvenli değildir.** Birimin `ExecStart` zincirinde 75
   başarı sayılırsa `resolve` kilit nedeniyle hiçbir şey yapmamışken `similarity` başlar ve
   birim temiz biter. Kilit meşgulken similarity **başlamamalıdır**; aynı zamanda alarm da
   yalnızca çıkış koduna göre susturulmamalıdır.
2. **Alarm `outcome`'a göre sınıflandırılmalıdır**, yalnızca çıkış koduna göre değil: başarısız
   birimde son `job_run.detail.outcome` okunur; `skipped_locked` tek seferlik ise düşük öncelik,
   `failed`/`partial`/`invalid_outcome` ise alarm.
3. **Uzun süren kilit sorunu sessizce başarılı sayılmaz.** Art arda `skipped_locked` (ya da
   belirli süre `completed`/`no_input` görülmemesi) alarm üretmelidir; aksi hâlde takılı kalmış
   bir elle koşu eşleştirmeyi günlerce durdurur ve kimse görmez.
4. PR1c'nin çözümü systemd davranışını **gerçek testlerle** doğrular (birim zinciri 75'te durur
   mu, alarm hangi `outcome`'ta tetiklenir); yalnızca birim dosyası incelemesi yetmez.

**PR1c — uygulama** (`infra/vps/bin/arilla_healthcheck.py`):

1. **Birim değişmedi.** `SuccessExitStatus` eklenmedi: 75 birimi yine başarısız sayar, kilitte
   similarity başlamaz, `OnFailure` tetiklenir. Sınıflandırma yalnızca alarm betiğindedir.
2. **Sınıflandırma.** `arilla-catalog-pipeline` başarısızsa `systemctl show` ile birimin son
   başlangıcı ve `ExecMainStatus`, ardından bu koşuya ait (o başlangıçtan sonraki) son cron
   `job_run` satırı okunur:
   - çıkış 75 **ve** `skipped_locked`, aynı işin bir önceki cron koşusu `skipped_locked` değil →
     **BİLGİ**: webhook'a tek mesaj, ölü adam anahtarına `/fail` yok; 5 dakikalık kontrolde
     kritik sayılmaz, parmak izine girmez, hatırlatma üretmez;
   - art arda ikinci `skipped_locked` → **kritik**;
   - diğer her durum (`partial`, `failed`, `invalid_outcome`, eski biçimli satır, çıkış kodu ile
     sonuç uyuşmazlığı, bu koşuya ait kayıt yok, systemd ya da veritabanı okunamadı) →
     **kritik** (kapalı tarafta kalır). Mesaj `outcome`/`reason` içerir.
   - Diğer birimlerin alarmı değişmedi.
3. **Tazelik.** Her iş (`resolve`, `similarity_edges`) için son "çalıştı" koşusu (`completed`,
   `no_input`, `partial`, `blocked_upstream`; `outcome` yoksa `success`/`partial`) **50 saatten**
   eskiyse kritik (`pipeline:freshness`). Takılı kilit, çalışmayan zamanlayıcı ve art arda atlama
   bu kuralla da yakalanır. Hiç kayıt yoksa uyarı.
4. **`blocked_upstream` alarm üretmez** (kullanıcı kararı, 8 Kasım): panel kenar aşamasında
   gösterir; alarm yorgunluğu yaratmaz.
5. **Gerçek test.** `infra/vps/bin/test-pipeline-units.sh` depodaki birimden test birimi üretip
   gerçek systemd'de (CI `vps-scripts`) sınar: 1. adım 75 → 2. adım başlamaz, `ExecMainStatus=75`,
   `OnFailure`; 2. adım 75 → `ExecMainStatus=75`; 1 → alarm; iki adım 0 → alarm yok; betik gerçek
   `systemctl show` çıktısını ayrıştırıp tek atlamayı BİLGİ, ikinciyi kritik sayar.

## Dağıtım politikası

`main`'e birleşme otomatik üretim dağıtımı demektir (karar 0137). Bu yüzden:

- PR1a geliştirilebilir, test edilebilir ve commit edilebilir.
- PR1a'nın **birleştirilmesi (= üretime alınması) ayrı bir karardır**; PR1b (panel görünürlüğü)
  ve PR1c (alarm sınıflandırması) ile koordine edilir.
- Birleştirmeden önce geçici operasyonel davranış değişiklikleri (yukarıdaki tablo: kilitte
  çıkış 75, similarity'de `partial`/`blocked_upstream`, panelde bu satırların "son iyi koşu"
  sayılması) PR açıklamasında ve `docs/ops.md`'de açıkça belgelenmeden birleştirme yapılmaz.
- `HAS_ELIGIBLE_PRODUCTS` (`EXISTS` üzerinde `offer_product_idx`): üretimde, yaklaşık 12,4 milyon
  satırlık tabloda tek koşuda yaklaşık 0,6 ms ölçüldü. Bu tek koşu gözlemidir, tekrarlı ölçüm
  değildir; sorgu yalnızca iki türde de vektörlü ürün 0 iken çalışır.

## Reddedilen alternatifler

- **`status` enum'una yeni değer** (`skipped`, `blocked`): migration + panel + CHECK değişikliği;
  geriye uyumlu değil.
- **Hata metninden sonuç çıkarmak** (`"kosu" in errors[0]`): metin değişince sessizce bozulur.
- **Kilit meşgulken çıkış 0**: zinciri devam ettirir ve elle koşu çakışmasını görünmez kılar.
- **`blocked_upstream` için çıkış 1**: her gece alarm (üretimde embedding yok) — alarm yorgunluğu;
  ayrıca bugünkü davranıştan (çıkış 0) sapma olurdu.
