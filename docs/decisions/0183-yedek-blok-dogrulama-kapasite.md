# 0183 — Blok tabanlı yedek, kapsamlı doğrulama ve kapasiteye bağlı geri yükleme provası

Tarih: 2026-11-11. Bağlam: karar 0110 (yedekleme), 0134 (WAL geri basıncı).

## Sorun (11 Kasım, üretimde salt okunur ölçüm)

| Ölçülen | Değer |
| --- | --- |
| R2 deposu | ~597 GB: WAL arşivi 373,2 GB (38.493 dosya) + yedek setleri 224 GB |
| Veritabanı kümesi | 75 GB (`arilla`); `base` 76 GB + `pg_wal` 13 GB disk üzerinde |
| Tam yedek | 17,2 GB depoda, 735 sn |
| Günlük fark yedeği | 9–16 GB depoda (dosya düzeyi: `offer` her gün çoğu sayfasına dokunuyor) |
| Normal günlük WAL | 19–28 GB depoda (sıkıştırılmış) |
| Haftalık `verify` | 11 Kas 02:38–06:38, **4 sa zaman aşımı** |
| Okuma hızı | ~41 MB/sn (1 Kas provası: 10,2 GB / 248 sn) |
| Boş disk | 59 GB / 193 GB |
| `backup` konteyneri | 1 CPU / 512 MB; aynı zamanda WAL'i R2'ye iten TLS sunucusu |
| Son TAM geri yükleme provası | 1 Kas (DB o zaman 45 GB); `pg-restore-test` 2×DB+2 GB ister → bugün çalışamaz |

**Doğrulama neden 4 saatte bitmedi:**
- 597 GB ÷ 41 MB/sn ≈ 4,0 saat. Sınır tam 4 saatti; ayrıca 38 bin küçük WAL dosyasının istek
  gecikmesi ekleniyordu. Bu bir **tahmin**: ağ ile CPU payını ayıran ölçüm yoktu.
- Doğrulama, WAL gönderen `backup` konteynerinde çalışıyordu ve tek CPU'yu WAL itimiyle
  paylaşıyordu. 06:30'daki besleme koşusu bol WAL üretiyor.
- Depo büyüdükçe bu süre de uzayacak. Dört haftalık saklamada tahminen 1–1,2 TB ≈ 7–8 saat.

## Karar

Kullanıcı kısıtları: ikinci sunucu yok; 4 haftalık PITR **korunur**; yedekler ve WAL silinmez;
saklama değişmez; geri yüklenebilirlik kanıtlanmadan "sağlıklı" denmez.

1. **Blok tabanlı yedek** (`repo1-block`). `PGBACKREST_REPO_BLOCK=y|n`, varsayılan `n`.
   - Açmak bilinçli bir `backup.env` değişikliği ve `pg-backup-configure` çalıştırmasıdır;
     dağıtım üretimi kendiliğinden değiştirmez.
   - `bundle=y` zaten açık.
   - Haritalar tam yedekte oluşur. Etki, açıldıktan sonraki ilk **zamanlanmış** tam yedekten
     (Pazar 01:36) sonra görünür; ek elle tam yedek gerekmez.
2. **İki doğrulama kapsamı, ayrı konteynerde.**
   - **Haftalık:** `verify --set`, son tam yedek ile en son yedek (ve setlerin WAL'i). Salı 10:30
     UTC; yedek, katalog ve besleme pencerelerinin dışında.
   - **Aylık:** tüm depo, 4 haftalık WAL dahil. Ayın 2. Çarşambası 09:30 UTC.
   - Doğrulama yeni `verify` servisinde çalışır: yalnız egress, yalnız depo yapılandırması salt
     okunur, 1 CPU / 512 MB, `read_only`. WAL sunucusuyla CPU paylaşmaz.
   - Paralellik artırılmadı (`process-max=2`); kaynak sınırları aşılmaz.
3. **Ölçüm ve koruma** (`backup_monitor.py`).
   - Ölçülenler: CPU, bellek, R2 okuması (konteyner ağ sayacı, alt sınır), boş disk, WAL kuyruğu.
   - Durdurma koşulları: WAL kuyruğu ≥ 64 dosya ya da en eski bekleme ≥ 10 dk; ya da süre sınırı
     (haftalık 2 sa, aylık 9,5 sa).
   - Durdurulan doğrulama "tamamlanamadı" (UYARI) sayılır, bozulma değil. Gerçek hata CRIT olur.
4. **Kapasiteye bağlı geri yükleme provası.**
   - **TAM prova** yalnızca `boş ≥ küme + 16 GiB WAL + 30 GiB taban` ise yapılır. Taban, günlük
     besleme indirmesinin (20 GiB) ve üretimin payıdır. Bu formül eski 2×DB+2 GB kuralının yerini
     alır; her bileşen ayrı ayrı gerekçelidir.
   - Koşul sağlanmazsa TAM prova **yapılmaz**. `restore-capacity.json` yazılır ve sağlık kontrolü
     `restore-capacity` UYARISI gösterir. Kapasite canlı hesaplanır, prova beklenmez.
   - **KISMİ prova** (`--partial`, `--auto`'nun yedeği): ana veritabanı `--db-exclude` ile seyrek
     ve sıfır dosyalar olarak geri yüklenir, `--type=immediate` kullanılır.
     - Kanıtladıkları: depo ve şifre çözme, manifest, global katalog, küçük veritabanları
       (`pg_amcheck`), WAL arşivinden kurtarma, PostgreSQL açılışı, hariç veritabanının
       kullanılamadığı.
     - **Tam kanıt DEĞİLDİR.** Ayrı dosyaya (`restore-test-partial.json`, `"proof":"partial"`)
       yazılır ve `restore-test` kontrolünü karşılamaz.
   - **Bekçi:** boş disk tabanın altına inerse, prova dizini bütçeyi aşarsa (gerçek ayrılmış
     bloklar) ya da WAL kuyruğu büyürse restore konteyneri durdurulur.
   - **Yalıtım denetimi:** prova dizini `restore-test/run-*` altında olmalı, sembolik bağlantı
     olamaz ve canlı veri diziniyle iç içe olamaz. PostgreSQL yalnızca sokette açılır, arşivleme
     kapalıdır.

## `--db-include` / `--db-exclude` değerlendirmesi

- Üretimde tek büyük veritabanı var: `arilla` (75 GB). Diğerleri `postgres`, `umami` ve şablonlar,
  toplam yaklaşık 30 MB.
- Seçici geri yükleme bu yüzden yalnızca mekanizmayı kanıtlar, `arilla` verisini kanıtlamaz.
  `arilla`'yı dahil eden her geri yükleme TAM geri yükleme kadar yer ister.
- `arilla` dosyalarının sağlama toplamı aylık tüm depo doğrulamasıyla denetlenir. Bu da geri
  yüklenebilirlik kanıtı değildir.
- Bugünkü kapasiteyle tam kanıt **yoktur** ve sağlık kontrolü bunu söyler.

## Etkiler (TAHMİN — ölçülmedi; Aşama C'de ölçülecek)

| Tahmin | Değer | Dayanak |
| --- | --- | --- |
| Fark yedeği küçülmesi | %30–60 | `offer` her gün çoğu sayfasına dokunduğu için o tabloda kazanç az; `offer_image`, eski `price_point` bölümleri ve sona eklenen tablolarda fazla |
| Haftalık depo kazancı | 50–100 GB (deponun %8–17'si) | Haftada 6 fark yedeği × 10–16 GB |
| WAL'a etkisi | **yok** | WAL en büyük kalem (373 GB); Aşama B'nin işi |
| Haftalık doğrulama süresi | ~15–30 dk | ~35 GB ÷ 41 MB/sn |
| Aylık doğrulama süresi | 4–8 sa | 0,6–1,2 TB ÷ 41 MB/sn |
| Tam yedek boyutu | biraz büyür | blok haritaları |

**R2 maliyeti** (Cloudflare liste fiyatı; güncelliği doğrulanmalı):
- **Depolama:** GB başına aylık 0,015 $. 597 GB ≈ aylık 9 $; 1–1,2 TB ≈ aylık 15–18 $.
- **Okuma:** çıkış ücreti yok. Okuma istekleri milyon başına 0,36 $; aylık tüm depo doğrulaması
  yaklaşık 100 bin istek, yani birkaç sent.
- **Blok yedek:** depolanan baytı azaltır; istek sayısını belirgin değiştirmesi beklenmez.
- Bucket'ın depolama sınıfı (Standard ya da Infrequent Access) panelden doğrulanmalı.

## Uyum ve geri alma

- **Mevcut yedekler:** depo biçimi değişmez; eski yedekler aynen geri yüklenir. Geri yükleme
  aynı imajdaki pgBackRest 2.59.3 ile yapılır.
- **Geri alma:** `PGBACKREST_REPO_BLOCK=n` → `pg-backup-configure`. Blok yedekleri saklama
  süresince (4 hafta) geri yüklenebilir kalır; sonraki tam yedek dosya düzeyine döner. Hiçbir
  şey silinmez.
- **Doğrulama ve prova değişiklikleri:** önceki birim dosyalarına dönülür; `pg-backup-activate
  install-timers` ile kurulur.

## Üretime geçiş (her adım ayrı, açık onayla)

1. Merge ve deploy: betikler ve compose kopyalanır. Zamanlayıcılar ve `backup.env` değişmez;
   yeni `verify` servisi ancak çağrıldığında çalışır.
2. `sudo /opt/arilla/vps/bin/pg-backup-activate install-timers`: yeni doğrulama zamanlamaları
   ve `--auto` prova.
3. Ölçüm: `sudo /opt/arilla/vps/bin/pg-backup verify` (son setler; yalnızca okur), sonra
   `cat state/verify-latest.json`. Gerçek CPU, bellek, R2 hızı ve WAL kuyruğu burada ölçülür.
4. `PGBACKREST_REPO_BLOCK=y` → `pg-backup-configure` → Pazar tam yedeği → fark yedeği ölçümü.
5. Kısmi prova: `sudo /opt/arilla/vps/bin/pg-restore-test --partial`.

## Reddedilen alternatifler

- **WAL saklamasını kısaltmak** (`repo1-retention-archive`): kullanıcı 4 haftalık PITR'ı korudu.
- **İkinci sunucuda tam prova:** ek maliyet; kullanıcı kapsam dışı bıraktı.
- **Doğrulamada `process-max`'ı artırmak:** kaynak sınırı; önce ölçüm.
- **Kısmi provayı tam kanıt saymak:** yanlış güven üretir.
- **Disk için `VACUUM FULL` ya da silme:** riskli; Aşama B kontrollü yoldan gider.
