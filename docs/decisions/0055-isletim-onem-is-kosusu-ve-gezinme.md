# 0055 — İşletim: önem, iş koşusu yazımı ve yönetim gezinmesi

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi

0052 ortak önem modelini ve `job_run` tablosunu getirdi; ama tabloya yazan
yoktu, `/yonetim/islemler` hâlâ dağınık uyarı kutularıyla konuşuyordu ve
başarısız toplama koşusu geri alınan yazımları sayıyordu. Yetki haritası
(0039), oturum kuralları (0044) ve görünürlük sınırları değişmez.

## Karar

1. **Toplama kaydı kaynağında doğru.** `collect/pipeline.py` başarısız
   koşuda işlemi geri aldıktan sonra `ingest_run`'a oluşturulan/güncellenen/
   fiyat noktası sayılarını **0** yazar; `offers_seen` gerçektir; geri alınan
   miktar `error_text`'e not düşer ("geri alindi (kalici degil): …"). Eski
   satırlar değiştirilmez; yönetim ekranı onları `writesRolledBack` ile
   gizlemeye devam eder.
2. **`job_run` yazanlar.** Python: `services/ingest/db/job_run.py`
   (`track(job)`; ayrı kısa bağlantı, işi asla düşürmez, hata özeti
   adres/e-posta/sır kırpılmış ≤ 500, `detail` düz ≤ 4 KB). İşler: `collect`,
   `collect_bootstrap`, `resolve`, `enrich`, `similarity` /
   `similarity_edges` / `similarity_prices`, `link_refresh`. Dry-run, sahte
   istemci ve yalnızca kayıt modları yazmaz (tazelik kanıtı gibi
   görünmesin). `collect.identifiers` yalnızca yerel bootstrap işidir,
   yazmaz. TypeScript: `packages/core/src/ops/job-run.ts` `withJobRun` — dört
   cron ucu (`discovery_slots`, `cleanup_auth`, `trigger_alerts`,
   `marketing_campaigns`, tetik `cron`). 180 günden eski koşular
   `cleanup-auth` içinde `purgeJobRuns` ile silinir.
3. **Boru hattı önce iş koşusuna bakar.** Aşamanın `job_run` kaydı varsa
   "son çalıştı" oradan, son koşu başarısız/takılıysa (> 2 saat) uyarı; yoksa
   verinin zamanına ("son kanıt") düşülür.
4. **Her durum bir bulgu.** `packages/core/src/admin/ops-findings.ts`
   partition, iş koşuları (takılı, başarısız, gecikmiş cron), boru hattı,
   mağazalar (takılı, üst üste başarısız, para birimi, hiç toplanmamış,
   bayat), eşleştirme kuyruğu (500), Keşfet slotu, link kuyruğu, ham görsel,
   KVKK temizlik birikimi ve maliyet sapmasını (24 saat > önceki 7 günün
   günlük ortalamasının 3 katı, en az 50 çağrı; fiyatlanmamış çağrı `info`)
   `AdminFinding`'e çevirir. Denetim çalışmazsa `unknown`. Tek başarısız
   koşu `info`, ops.md eşiği (2 üst üste) `warning`. `critical` yalnızca
   partition dışı satır ve saklanmaması gereken ham görsel.
5. **Genel bakış: "Şimdi dikkat isteyenler".** Aynı bulgulardan yalnızca
   kritik/uyarı/bilinmiyor. Yönetici işletim bulgularını da görür; moderatör
   bugün gördüğü sinyallerden (mağazalar, boru hattı, kuyruk) türetileni.
   Bağlantı yalnızca rolün açabildiği sayfaya. Kalıcı alarm durumu ve
   bildirim yok; liste her bakışta yeniden türetilir.
6. **Gezinme.** Gruplar: Genel bakış · Katalog ve mağazalar · Arama ·
   İşletim (Sistem sağlığı, İş koşuları) · Yönetim · Büyüme. Etkin öğe en
   özel eşleşmedir (`activeNavHref`); konum yolu layout'tadır.
7. **Kullanıcı araması (0038).** Diğer daldaki 0038 migration'ı birebir
   alındı; 3+ karakterde dört indeksli UNION, 2 karakterde eski OR biçimi
   (trigram yok, UNION orada 3 kat yavaş). Ölçüm yerel, 200 bin kullanıcı /
   140 bin kimlik: seyrek terim 707 → 2-3 ms, eşleşmeyen 650 → 0,1 ms, ad
   25 → 31 ms, çok yaygın ("gmail") 110 → 330-440 ms. Arama 5 sn ile sınırlı.

## Reddedilen alternatifler

- **Python'un iş koşusunu işin kendi bağlantısında yazması:** işin
  `rollback()`'i kaydı siler, kaydın `commit()`'i yarım işi kalıcı yapar.
- **"Şimdi çalıştır / yeniden dene" düğmesi:** gözlem önce (0039, 0052).
- **Bildirim/alarm tablosu:** 0039'da reddedildi; dikkat listesi türetilir.
- **Her boyutta UNION:** 2 karakterlik aramada 0,4 sn → 1,5-2,8 sn.
