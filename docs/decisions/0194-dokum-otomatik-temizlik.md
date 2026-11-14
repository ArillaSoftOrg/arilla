# 0194 — Migration öncesi dökümler: başarılı deploy sonunda otomatik temizlik

Durum: **kabul** (kullanıcı onayı, 14 Kasım 2026). İlgili: 0187 (saklama, onaylı silme), 0188 (katalog eşiği), 0164.

## Bağlam

0187, migration öncesi dökümlerin silinmesini yalnızca elle `prune --confirm` ile yapılacak şekilde sınırladı.
0188 (PR #331) ise dökümden sonra boş alan 70 GiB katalog eşiğinin altına düşecekse migration deploy'unu durduruyor.

14 Kasım ölçümü:
- disk 193 GB, boş 84 GB;
- veritabanı ve volume'lar 89 GB;
- 2 döküm, toplam 19,4 GB; ikisi de "en yeni 2" kuralıyla korunuyor.

Her migration'lı deploy yaklaşık 10 GB'lık yeni bir döküm bırakır. Elle temizlik turu unutulursa iki sorun çıkar:
- sonraki migration deploy'u katalog eşiğinde durur;
- ya da `catalog-auto` yayını sessizce durur.

0187 de "her migration'lı deploy'dan sonra aynı gün `prune --confirm` turu" gerektiğini kalıcı risk olarak yazmıştı.

## Karar

1. **Ne zaman:** Yalnızca **başarılı** bir migration deploy'unun sonunda. Döküm `success` olarak işaretlendikten
   sonra, deploy kilidi hâlâ tutulurken `pre_migrate_dumps.py auto-prune --dump <yeni>` çalışır.
   - Migration'sız deploy temizlik yapmaz.
   - Başarısız ya da geri alınan deploy da temizlik yapmaz.
   - Zamanlayıcı yok, eşik tabanlı tetik yok.
2. **Önce yeni döküm doğrulanır:** SHA-256 ve tam veri okuması (`pg_restore -f /dev/null`, yalıtılmış konteyner).
   Okunamazsa hiçbir şey silinmez ve deploy uyarı yazar.
3. **Saklama değişmez (0187):**
   - Doğrulanmış en yeni 2 başarılı döküm korunur.
   - Başarısız, yarım kalmış ya da metadatasız döküm asla silinmez.
   - Tam okunmamış döküm aday olmaz.
4. **Silmeden önce denetim:**
   - Korunanlar tam okunur. Yeni döküm bu çalışmada zaten okunduğu için tekrar okunmaz.
   - Adayların boyutu ve SHA-256'sı metadatayla karşılaştırılır; biri tutmazsa hiçbir şey silinmez.
   - Adaylar tam okunmaz. Silinecek dosyayı okumak deploy süresini uzatır, kanıta katkısı yoktur.
5. **Kilit:** `auto-prune`, deploy kilidinin (flock ya da `.deploy.lock.d`) başka bir süreçte tutulduğunu
   doğrular. Kilit tutulmuyorsa reddeder. Elle `prune --confirm` eskisi gibi kilidi kendisi alır.
6. **Denetim izi:** Her silme `state/pre-migrate-prune.log`'a `actor: "auto-prune (...)"` ile yazılır.
7. **Hata deploy'u bozmaz:** Temizlik geri alma sonrasında çalışır (`ROLLBACK_ARMED=0`). Hatası yalnızca `UYARI`
   olarak yazılır; deploy sonucu `success` kalır.
8. **Kapatma:** `/opt/arilla/state/dump-auto-prune.off` dosyası varsa temizlik atlanır. Kod değişikliği ya da
   revert gerekmez.
9. **Elle yol durur:** `report`, `verify`, `prune [--confirm]` aynen çalışır.

## Etki

- Disk kararlı durumda en fazla yaklaşık 2 döküm (~20 GB) taşır. Her migration deploy'u yaklaşık 10 GB'ı kendisi geri verir.
- Deploy süresi yalnızca migration'lı deploy'larda uzar: yeni ve önceki dökümün tam okuması (her biri ~100–200 sn,
  1 CPU) ve SHA-256 hesapları. Deploy işinin zaman aşımı 30 dakikadır.
- Veritabanı büyümesi bu kararın kapsamı dışındadır. Boş alanı uzun vadede belirleyen etken budur.

## Reddedilen alternatifler

| Alternatif | Neden değil |
| --- | --- |
| Boş alan 80 GiB altına inince silen zamanlayıcı | En yeni 2 korunduğu için çoğu zaman silecek bir şey bulamaz; yeni döküm ancak deploy ile oluşur |
| Deploy'dan sonra ayrı systemd işi (asenkron) | Kilidi beklemek, yeni birim kurmak ve sonucu ayrıca izlemek gerekir; deploy günlüğünde görünmez |
| Adayları da tam okumak | Silinecek dosyayı ~2–3 dk okumak deploy'u uzatır; boyut + SHA-256 değişikliği yakalar |
| `KEEP=1` | Art arda iki migration deploy'unda ilk geri alma noktası kaybolur (0187) |
