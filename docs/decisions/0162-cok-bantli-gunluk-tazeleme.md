# 0162 — Çok bantlı günlük tazeleme: süre bütçesi, adil sıra, bekleyen ilk yükleme

**Tarih:** 31 Ekim 2026
**Durum:** Önerildi (PR). Migration yok. Üretim verisine dokunulmadı; zamanlayıcı ve servis
birimleri değişmedi (`TimeoutStartSec=6h`, 06:30/18:30 UTC).
**İlişkili:** 0112 (senkronizasyon), 0114 (ilk yükleme), 0117 (`no_deactivate`), 0145 (günlük
tazeleme), 0152 (yazmadan önce bütünlük), 0156 (okuma yolunda tazelik; **değişmedi**).

## Bağlam

Admitad AliExpress programı fiyat bandına göre bölünmüş birden çok besleme sunar (10–25$ bandı
5,13 milyon kayıt). Bugüne kadar yalnız 10–25$ bandı (besleme 7) bağlıydı; kalan bantlar sırayla
bağlanıp elle ilk yüklemeden geçirilecek. Bunlar etkinleşince `feeds daily --merchant aliexpress`
tek koşuda ondan fazla besleme işleyecek (toplam on milyonlarca kayıt). Üç sorun çıktı:

1. İlk yüklemesi bitmemiş **etkin** besleme `initial_load_required` sorunu üretiyor, koşu
   `partial` bitiyor, çıkış kodu 1 olup `arilla-alert@` tetikleniyordu; yani bir bandın elle ilk
   yüklemesi sürerken yüklü bantların günlük tazelemesi "başarısız" görünüyordu.
2. Hiçbir süre sınırı yoktu: tüm "due" beslemeler baştan indirmeye gönderiliyor (staging diskini
   şişiriyor), koşu `TimeoutStartSec=6h` ile sessizce öldürülebilirdi.
3. Bir ürün fiyat bandı değiştirdiğinde iki dosyada birden görünebilir. Besleme kimlik sırasıyla
   işlenince **eski** dosyanın fiyatı **taze** dosyanın fiyatının üzerine yazılır ve iki sahte
   `price_point` (20 → 30 → 20 gibi) oluşur.

## Karar

1. **Bekleyen ilk yükleme bilgidir, hata değil.** Etkin ama hiç `complete` sürümü olmayan besleme
   günlük işte yine indirilmez (aşama kapıları atlanmaz, 0114); yalnız
   `feeds_initial_load_required` ve `feeds_initial_load_ids` sayılır. Duraklatılmış besleme ve bu
   koşuda ertelenen besleme tazelik raporunda sorun sayılmaz. Hiç yüklü besleme yoksa
   (`initial_load_required` tek başına) koşu yine `failed` olur; `no_active_feeds` de öyle.
2. **Süre bütçesi** (`--budget-hours`, varsayılan 4; ortam `FEED_DAILY_BUDGET_HOURS`). Bütçe
   dolunca YENİ besleme indirmesi/birleştirmesi başlamaz; kaynağı değişmemiş beslemeler (indirme
   yok, saniyeler) yine geçilir. Başlamış bir birleştirme bitirilir; servis yine de öldürülürse
   mevcut parça kontrol noktaları ve 24 saatlik indirme yeniden kullanımı (0114) devam ettirir.
   Ertelenenler `feeds_deferred` ve `feeds_deferred_ids` olarak raporlanır; hata değildir.
   4 saat: 6 saatlik sınır içinde son birleştirmeye (ilk büyük gün: 5,13 M kayıt ≈ 81 dk) ve bir
   indirmeye pay bırakır.
3. **Ön indirme penceresi.** Önceden tüm liste indirmeye gönderilmez; birleştirme imlecinin
   `parallel + 1` ilerisine kadar indirilir. Bütçe dolarsa kullanılmayan ön indirmeler iptal edilir
   ya da dosyaları silinir (yarım/atıl dosya kalmaz). En kötü durumda boşa giden indirme
   `parallel + 1` dosyadır. Admitad bağlantı sınırı (toplam 3) korunur: indirme havuzu
   `--parallel-downloads` (varsayılan 2) işçidir.
4. **Sıra.** Beslemeler `feed_source.source_updated_at` artan sırayla (kaynağı en eski önce, en
   taze **son**) birleştirilir; bilinmeyen tarih en taze sayılır. Böylece bir ürün birden çok
   dosyada farklı fiyatla görünürse en taze kaynağın fiyatı son yazar ve sahte oynama olmaz.
5. **Açlık yok.** Önceki tamamlanan `feed_daily` koşusunun `detail.feeds_deferred_ids`
   (`job_run`, aynı merchant) değerindeki besleme listenin başına alınır (kendi aralarında yine
   kaynak sırasıyla). Bütçe her koşuda dolsa bile ertelenen besleme sonraki koşuda ilk işlenir;
   en taze kaynaklı beslemeler sonsuza dek açıkta kalmaz.

## Kapsam dışı / kalan risk (açıkça)

- **Kayıt düzeyinde "daha eski kaynak yeni fiyatı ezmesin" koruması yapılmadı.** Bunun için her
  teklifin son fiyatı hangi kaynak zamanıyla yazdığı gerekir; `source_snapshot` yalnız işlem
  zamanlarını (`started_at`, `completed_at`) taşıyor, kaynak üretim zamanı yok. Çözüm bir sütun
  (migration; şemanın tek sahibi `packages/db`) ya da `attributes_raw`'a kontrol meta verisi
  yazmaktır; ikincisi kaçak bir veri yolu olurdu ve reddedildi. Bu yüzden koruma **sıralamaya**
  dayanır. Kalan durumlar:
  - Bütçe nedeniyle ertelenen **eski** kaynaklı bir besleme, bir sonraki koşuda önce işlenir ve o
    arada başka bir beslemeden yazılmış **daha taze** bir fiyatı geçici olarak ezebilir. Etki:
    yalnız iki bantta birden bulunan (bant sınırında fiyat oynayan) ürünler; her biri en çok bir
    çift fiyat noktası; bir sonraki taze dosyada düzelir. `price_point` yine silinmez/değişmez.
  - Tek koşuda kaynakları saatler arayla (17:25–19:13 UTC) üretilen bantlar: akşam koşusunda
    yalnız bir kısmı güncellenmiş olabilir; kaynağı eski olan zaten yeniden işlenmez
    (`source_unchanged`).
- Kaynak zamanı `NULL` olan besleme en taze sayılır (her zaman due olduğu için sona kalır).
- `no_deactivate`, `config.freshness` ve zamanlayıcılar değişmedi. Teklif kimliği
  `(merchant_id, external_id)` upsert anahtarı olarak kalır: bant değiştiren ürün aynı `offer`
  satırını ve `price_point` geçmişini korur, üyelikleri besleme başına tutulur
  (`feed_source_offer`), hiçbir beslemede kalmayan teklif 48 saat beklemeden sonra ve %10 tavanla
  pasifleşir (0112) — `no_deactivate` açık olan beslemelerde hiç.

## Beklenen günlük maliyet (üretim ölçümü + tahmin)

Ölçüm (üretim `job_run`): 30 Ekim koşusu 2.908.815 kaydı hiçbiri değişmeden 1.745 sn'de işledi
(~0,6 ms/kayıt, indirme dahil); 31 Ekim ilk büyük koşu 5.130.282 kayıt (2,42 M yeni, 1,97 M
değişen) 4.884 sn (~0,95 ms/kayıt). Değişmeyen kayıt `upsert`e girmez (0114) ama beslemedeki her
kayıt için `feed_source_offer` üyeliği güncellenir; maliyet kayıt sayısıyla doğrusal artar.
Tahmin (ölçüm DEĞİL): ~12 milyon kayıtta değişmeyen koşu ≈ 2 saat, her kaydın değiştiği kötü gün
≈ 3,2 saat; ikisi de 4 saatlik bütçe içinde. İndirme bağlantı başına ~0,3–0,6 MB/s olduğundan
besleme başına 1–2 GB için 30–90 dk sürer ve `--parallel-downloads 2` ile birleştirmeyle
örtüşür; bütçe dolarsa kalan beslemeler ertelenir.

## Reddedilen alternatifler

- **`TimeoutStartSec` / zamanlayıcıyı değiştirmek:** sorun süre sınırı değil, sınırın sessiz
  ölüm olması; bütçe koşuyu temiz bitirir. Birim dosyaları ayrı onaylı adımdır.
- **Besleme başına ayrı zamanlayıcı:** Admitad toplam bağlantı sınırını (3) ve bant dosyalarının
  ardışık üretim saatini aşırı yönetim yüküne çevirir; tek koşuda sıra/bütçe yeterli.
- **Sıralamayı `last_success_at`'e göre yapmak:** ertelenenleri öne alırdı ama aynı koşuda eski
  dosyayı taze dosyanın önüne koyabilirdi (sahte fiyat oynaması). Açlık önceliği yalnız ertelenen
  kimlikler için eklendi.
- **Bütçe dolunca yarım besleme yazımını kesmek:** parça kontrol noktaları devam ettirir ama
  kesinti anı ürünlerin bir kısmının yeni, bir kısmının eski fiyatla kalması demektir; başlamış
  birleştirme bitirilir.
