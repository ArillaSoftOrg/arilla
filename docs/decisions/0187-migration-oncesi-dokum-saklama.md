# 0187 — Migration öncesi dökümler: kanıta dayalı saklama, disk denetimi, onaylı silme

Tarih: 2026-11-12. Bağlam: karar 0109 (dağıtım motoru), 0183 (yedek boyutu ve geri yükleme kapasitesi).

## Sorun (12 Kasım, salt okunur ölçüm)

`arilla-deploy`, bekleyen migration olduğunda veritabanının tam `pg_dump`'ını alıyor ve son 5 tanesini tutuyordu.

| Ölçülen | Değer |
| --- | --- |
| Döküm sayısı ve toplamı | 5 dosya, **45,50 GB** (8,46 / 8,63 / 9,06 / 9,68 / 9,68 GB) |
| Kaynak | Hepsi başarılı deploy'lar (0108, 0109, 0110, 0111+0112, 0113); bugün iki tanesi 15 dk arayla |
| Bütünlük | Beşinde içindekiler (TOC: 1098–1126 girdi, 119–123 tablo verisi) okundu. En eski ve en yenide tam veri okuması TAMAM (97 / 111 sn; ağsız, 1 CPU, salt okunur konteyner). SHA-256 değerleri kaydedildi. |
| Disk denetimi | Döküm öncesi yalnız ≥ 3 GiB boş alan aranıyordu; döküm ~9,7 GB. Disk dolabilirdi. |
| Doğrulama | Yalnız `pg_restore -l`; veri blokları okunmuyordu. |
| Boş disk | 67,0 GB. Tam geri yükleme provası için ~121 GiB gerekiyor (0183). |

**Kurtarma kapsamı.** pgBackRest/R2, 18 Ekim'den bu yana her ana PITR sağlıyor, ama bu VPS'te tam geri yükleme için
yer yok. Yerel dökümün tek özgün değeri, son migration'ı **tablo düzeyinde** hızlı geri almak (`pg_restore -t`) ve R2
erişilemezken çalışmak. Bir sonraki migration'dan sonra bu değer büyük ölçüde azalır. Dökümler şifresiz kişisel veri
içerir (root:0600).

## Karar (kullanıcı onayı, 12 Kasım)

1. **Saklama:** Başarılı deploy'ların **doğrulanmış** (SHA-256 + tam veri okuması) en yeni **2** dökümü korunur.
   - 2, bugünkü gibi art arda iki migration deploy'unda ilkinin geri alma noktasını da korur.
   - Yaş sınırı bu ikisini asla etkilemez.
2. **Korunanlar:** Başarısız, yarım kalmış (`dumping`, `created`, `migrated`, `failed`, `dump_failed`) ya da
   metadatası olmayan döküm **asla silme adayı olmaz**; insan kararı gerekir.
3. **Otomatik silme yok.** Deploy ve sağlık kontrolü adayları yalnızca raporlar. Silme yalnızca
   `pre_migrate_dumps.py prune --confirm` ile yapılır:
   - deploy ile aynı kilit alınır;
   - korunan ikisi ve her aday yeniden SHA-256 ve tam veri okumasından geçer;
   - yol doğrulaması ve sembolik bağlantı reddi uygulanır;
   - boyut ve SHA-256 değişmişse durur;
   - her silme `state/pre-migrate-prune.log`'a fsync'li denetim kaydı olarak yazılır.
4. **Disk denetimi.** Bekleyen migration varsa, hiçbir dosya kurulmadan önce
   `boş ≥ son döküm × 1,15 (ilk dökümde veritabanı × 0,20) + 30 GiB taban` aranır. Yetmezse deploy çıkış 2 ile durur;
   dosyalar, servisler ve sürüm işaretçisi değişmez.
5. **Migration yalnızca doğrulanmış dökümden sonra başlar.** Metadata `begin` ile açılır, ardından `pg_dump` yapılır,
   ardından `finish` çalışır (boyut, SHA-256, TOC: veri var ve `schema_migration` verisi var). Biri başarısızsa
   migration başlamaz, otomatik geri alma yapılır, döküm `dump_failed`/`failed` olarak korunur.
6. **Tablo sayısı kıyaslanmaz:** azalma meşru bir şema değişikliği olabilir, bozulma sayılmaz.
7. **Metadata** (`<döküm>.meta.json`, 0600):
   - migration listesi, deploy kimliği (`STAMP`), sha;
   - boyut, SHA-256, TOC özeti;
   - durum ve geçmişi, doğrulama sonucu.
8. **Haftalık tam veri okuması** (`arilla-dump-verify.timer`, Pazartesi 11:30 UTC): en yeni döküm. Sonuç sağlık
   kontrolünde görünür:
   - okuma başarısız → **kritik**;
   - 8 günden eski ve okunmamış → **uyarı**;
   - bekleyen ya da metadatasız döküm var → **uyarı**.
   Bu okuma **gerçek bir PostgreSQL geri yükleme kanıtı değildir** (0183'teki kapasite açığı sürüyor).
9. **pgBackRest/R2 ve 4 haftalık PITR değişmez.**

## Disk etkisi

Ölçülen boş alan bugün 67,0 GB.
- 8–9 Kasım'daki üç eski döküm (26,14 GB) `adopt --confirm`, tam okuma ve `prune --confirm` ile silinirse boş alan
  **93,2 GB** (86,8 GiB) olur.
- Tam geri yükleme provası için açık **~34 GiB** kalır. Hiç döküm tutulmasa bile açık ~16 GiB; döküm politikası tek
  başına yetmez.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Deploy'un eski dökümleri otomatik silmesi (eski `KEEP=5`) | Kullanıcı kararı: silme yalnızca açık onayla |
| `KEEP=1` | Art arda iki migration deploy'unda ilk geri alma noktası kaybolur |
| Yaşa göre silme | En yeni ikisini silebilir; olay tabanlı saklama daha doğru |
| Tablo sayısı azalınca bozuk saymak | Meşru şema değişikliğini engeller |
| Dökümü R2'ye taşımak | pgBackRest zaten R2'de; ikinci kopya maliyet ve PII riski, kapsam dışı |
