# 0052 — Yönetim konsolu ortak temeli: önem modeli, iş koşusu ve arama ölçümü

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi

0051'in "son kanıt" yaklaşımı ve denetim bulguları üç ortak ihtiyaç bıraktı:
ekranlar arası tutarlı bir önem dili, işlerin gerçek koşu geçmişi ve arama
kalitesini (sonuçsuz / tanınmayan sorgu) gösterecek en küçük ölçüm. Yetki
haritası (0039), oturum kuralları (0044) ve görünürlük sınırları değişmez.

## Karar

1. **Önem modeli** (`packages/core/src/admin/severity.ts`): `critical`,
   `warning`, `unknown`, `info`, `healthy`. Ortak bulgu tipi `AdminFinding`
   (başlık, anlam, kanıt, ne yapmalı, teşhis sayfası + o sayfanın yeteneği,
   kanıt zamanı). Arayüzde `SeverityBadge` ve `FindingList`; bağlantı yalnızca
   izleyicinin rolünün açabildiği sayfaya verilir (`capabilitiesFor`, yalnızca
   gösterim koşulu). Kesin olmayan sinyal `info`'dur; "denetim çalışmadı"
   `unknown`'dur, sessizce sağlıklı sayılmaz.
2. **`job_run`** (migration 0041): her iş koşusunun (python boru hattı işleri
   ve cron uçları) başlangıç, bitiş, durum, tetik (manual/cron/worker), küçük
   `detail` (≤ 4 KB, düz sayılar) ve kısa, sırsız `error_summary` (≤ 500).
   İşletim sinyalidir: denetim kaydı, analitik ya da genel log tablosu değil.
   Çalıştır/yeniden dene düğmesi yok (gözlem önce). 180 gün saklanır.
   `ingest_run` (mağaza başına) aynen kalır.
3. **`search_query_day`** (migration 0040): (gün, normalize sorgu) başına tek
   satır; arama, sonuçsuz, yedek listeye düşen ve netleştirme sayaçları, son
   sonuç sayısı, sözlükte karşılığı olmayan en fazla 8 kelime. Olay tablosu
   değil, kimlik yok (kullanıcı, oturum, IP). E-posta, telefon, adres ya da uzun
   rakam dizisi içeren sorgular hiç yazılmaz. 90 gün saklanır. Teşhis ekranı
   (yönetim arama tanısı) yazmaz.

## Gerekçe

- Boru hattı işleri zamanlanmış değil; "son kanıt" yeni veri yoksa sessiz
  kalıyordu. Koşu kaydı, işin çalışıp çalışmadığını tahminsiz söyler.
- "Sonuçsuz arama oranı" ve "sözlüğe eklenmesi gereken kelime" sorularına
  mevcut veriyle cevap verilemiyordu (`query_resolution` sonuç sayısı tutmaz;
  `user_activity_event` rızaya bağlı ve kullanıcıya bağlıdır).

## Reddedilen alternatifler

- **Olay başına arama kaydı:** kimlik içermese bile hacim kullanıcı sayısıyla
  büyür ve tek tek aramaların izini tutar; günlük özet yeterli.
- **`query_resolution`'a sayaç eklemek:** zaman penceresi ("son 7 gün")
  olmaz; önbellek tablosunun anlamını da bulandırır.
- **Genel log tablosu / bildirim alt sistemi:** 0039'da reddedildi; dikkat
  listesi mevcut durumdan türetilir.
