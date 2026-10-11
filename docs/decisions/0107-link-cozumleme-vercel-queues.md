# 0107 — Link çözümleme: Vercel Queues + Python Function (VPS'siz yol)

**Tarih:** 12 Ekim 2026
**Durum:** Kabul edildi, kod hazır, **varsayılan kapalı** (`LINK_QUEUE_BACKEND=redis`).
0014/0035/0090'ın "Python worker ayrı hostta Redis kuyruğunu tüketir" kısmını
**bayrakla değiştirilebilir** kılar; çözümleme mantığı, güvenlik kuralları ve
`LINK_SEARCH_PUBLIC` kapısı değişmez. Etkinleştirme Vercel panelinde ve önce
önizlemede doğrulanarak yapılır (aşağıda "Doğrulanmamış noktalar").

## Bağlam

Link araması bugün şöyle çalışır: web `link_resolution_request` satırı yazar ve
Redis listesine (`queue:link_resolution`) `{"request_id"}` bırakır; ayrı bir
VPS'te sürekli çalışan Python süreci (`python -m collect.link --worker`) BRPOP
ile alır, sayfayı getirir, kataloga yazar ve satırı `resolved`/`failed` yapar.
Amaç, VPS ve sürekli çalışan süreç olmadan, aynı Python mantığıyla Vercel
üzerinde çalışmak.

## İncelenen seçenekler

| Seçenek | Karar | Gerekçe |
|---|---|---|
| **A. Vercel Queues (push) + Python subscriber, aynı Vercel projesinde (Services, Beta)** | **Seçildi** | Python mantığı (2,4 bin satır: SSRF koruması, çıkarım, robots, görsel embedding) olduğu gibi kalır; tetikleme otomatik; VPS yok. |
| B. TypeScript consumer (`handleCallback` + `apps/web`) | Reddedildi | Çözümleme, çıkarım ve soket düzeyinde SSRF korumasının (DNS sabitleme, yönlendirme başına yeniden denetim) TS'e yeniden yazılması gerekir: büyük yüzey, güvenlik gerilemesi riski. TS'in Python'u çağırması ise mimari sınırı bozar. |
| C. Poll modu (kendi worker'ımız Vercel Queues'tan çeker) | Reddedildi | Yine sürekli çalışan süreç ve host gerekir; kaldırmak istediğimiz şey bu. |
| D. Ayrı Vercel projesi (kök `services/ingest`) | Reddedildi | Topic'ler projeye aittir; web projesi başka projenin topic'ine yazamaz. Köprü HTTP çağrısı olurdu (sınır ihlali). |
| E. Cron ile Redis'i boşaltan Python Function | Reddedildi | Cron en sık dakikada bir (Hobby'de günde bir): kullanıcı bekleme süresi 60 sn+ artar. |

## Karar

1. **Taşıma katmanı bayrakla seçilir:** `LINK_QUEUE_BACKEND=redis` (varsayılan,
   bugünkü davranış) ya da `vercel`. Durumun tek doğrusu PostgreSQL'dir
   (`link_resolution_request`); kuyruk yalnızca "çalış" sinyalidir.
   Web'in `checkLinkSearchUrl` ile doğrulama, önbellek (`findReusableLinkRequest`),
   arama hakkı ve iade akışı aynen kalır; yalnızca son adım (kuyruğa bırakma)
   `publishLinkResolution` arkasına alınır.
2. **Vercel yolu:** topic `link-resolution`, mesaj `{"request_id": "<uuid>"}`
   (başka veri yok: URL, oturum, kullanıcı mesajda taşınmaz). Web `send` ile
   `idempotencyKey = request_id` ve 10 dk saklama süresiyle bırakır.
3. **Consumer Python'dur ve yeniden yazılmaz:** `collect/link/subscriber.py`
   `@subscribe(topic=...)` ile kayıt olur, `pyproject.toml`'daki
   `[[tool.vercel.subscribers]]` girdisiyle Vercel bunu **özel (public rotası
   olmayan), kuyruk tetiklemeli** bir fonksiyona derler. Mevcut `process_one`
   mantığı (`resolve_url`, görsel embedding, `_mark`) aynen kullanılır.
4. **Mimari sınır:** Web Python'u çağırmaz, Python web'i çağırmaz. İletişim
   PostgreSQL ve kuyruktur (Redis ya da Vercel Queues). Python'un **herkese
   açık** HTTP rotası yoktur; fonksiyon yalnızca platformun kuyruk
   bildirimiyle tetiklenir. `CLAUDE.md` bu ifadeyle güncellendi.
5. **İdempotans (en-az-bir-kez teslimat):**
   - Web: aynı `request_id` için `idempotencyKey`; çift gönderim düşer.
   - Python: satır **atomik sahiplenilir** (`UPDATE … WHERE status='queued'`
     ya da, yeniden teslimatta (`delivery_count > 1`), takılı kalmış
     `processing`). Bitmiş (`resolved`/`failed`) satır sessizce atlanır.
     Şema değişmez (migration yok).
   - Yazma tarafı zaten idempotent: `(merchant_id, external_id)` unique
     (kural 7); görsel embedding'i hash ile tekrar üretilmez.
6. **Hata ve yeniden deneme:**
   - Sitenin durumu (404, robots, SSRF engeli, 429 …) kalıcı sonuçtur:
     satır `failed` + kararlı `error_code`, mesaj onaylanır, **yeniden
     denenmez** (siteye art arda gidilmez).
   - Altyapı hatası (DB bağlantısı, beklenmeyen istisna): `RetryAfter`
     (15 sn, ikiye katlanan, en çok 3 teslimat). Son teslimatta satır
     `failed`/`unexpected` yapılır ve mesaj onaylanır; kuyruk "zehirli mesaj"
     tutmaz (Vercel Queues'ta dead-letter kuyruğu yoktur).
7. **Zaman aşımı:** sayfa/görsel istekleri bugünkü sabit sınırlarında kalır
   (`safe_http`: 20 sn toplam, 10 sn okuma, 5 sn bağlantı; 2 MB). Fonksiyon
   süresi, kullanıcı bekleme penceresiyle (madde 9) uyumlu olacak şekilde 120 sn
   ile sınırlanır (panel/yapılandırma; bkz. doğrulanmamış noktalar).
8. **Maliyet kontrolleri korunur:** her embedding çağrısı `api_usage`'a yazılır
   (değişmedi); abone `max_concurrency=2` ile sınırlanır; Jina token bütçesi
   süreç içidir, bu yüzden her örneğe `JINA_TOKENS_PER_MINUTE / max_concurrency`
   düşer (toplam yapılandırılan değeri aşmaz). Kuyruk işlemleri mesaj başına 4 KiB
   altında kalır (yalnızca UUID). Redis web'de olduğu gibi kalır (arama duvarı,
   hak sayaçları, önbellek, oran sınırı); Vercel yolunda link kuyruğu için
   kullanılmaz.
9. **2 dakikalık bekleme akışı korunur** (`IN_FLIGHT_TTL_MS`). Gerekçe: Vercel
   yolunda tipik gecikme saniyeler (soğuk başlatma + tek sayfa); 120 sn sınırı
   hem fonksiyon süresiyle hem de kullanıcının "worker yanıt vermedi" eşiğiyle
   aynı. Yeniden deneme süreleri bu pencereye sığacak şekilde seçildi; sığmayan
   bir teslimat ölü sayılan satıra geç yazar ve zararsızdır (yeni istek yeni satırdır).
10. **Yönetim paneli:** Redis kuyruk uzunluğu yalnızca `redis` arka ucunda anlamlıdır.
    `vercel` arka ucunda gösterge, son 2 dakikadaki `queued` satır sayısını
    veritabanından okur (aynı uyarı eşiği).

## Doğrulanmamış noktalar (önizlemede doğrulanmadan etkinleştirilmez)

Vercel belgeleri aşağıdakileri açıklamıyor; yerel ortamda `vercel` CLI olmadığı
için de derleme denenemedi. Her biri etkinleştirme öncesi **önizleme
dağıtımında** doğrulanacak:

1. Services için proje **Root Directory'sinin repo köküne** taşınması
   gerekir (bugün `apps/web`). `services` anahtarı varken üst düzey `functions`,
   `buildCommand` vb. geçersiz olur; `crons`'un (bugün `apps/web/vercel.json`)
   geçerli kalıp kalmadığı belgelenmemiş.
2. Yalnızca abone içeren (ASGI/WSGI `app` olmayan) bir Python service'in
   derlenip derlenmediği belgelenmemiş. Gerekirse en küçük bir `app` giriş
   noktası eklenir (bu, **herkese açık rota yaratmamalı**: service üst düzey
   `rewrites`'a bağlanmaz, yani özel kalır).
3. `[[tool.vercel.subscribers]].entrypoint` modül yolunun service `root`'una
   göreli olduğu varsayılıyor (`collect.link.subscriber`).
4. Üretilen kuyruk fonksiyonunun `maxDuration` ayarı (service `functions`
   anahtarı) belgelenmemiş.
5. pnpm workspace'li Next.js service'inin kök dizin repo kökündeyken derlenmesi.
6. `psycopg[binary]`, `pillow` tekerlekleri Vercel Python ortamında (beklenen: sorunsuz).
7. Bu özellikler **Beta** (Queues, Python SDK, Services). Bayrak kapalıyken hiçbiri
   etkin değildir.

Referans yapılandırma: `vercel.json` (repo kökü; Vercel Root Directory repo köküne alınmadıkça yok sayılır;
Root Directory `apps/web` iken Vercel kök `vercel.json`'u okumaz, yani bu dosya
dağıtımı etkilemez).

## Geri alma

`LINK_QUEUE_BACKEND=redis` (ya da silmek) + Redis worker'ını yeniden başlatmak.
Migration yok. Redis yolu kaldırılmamıştır; aynı satır şeması ve aynı
`process_one` kullanılır.

## Etkilenmeyenler

`LINK_SEARCH_PUBLIC` (kapalı kalır), `CHAT_LINK_*`, `WEB_SEARCH_*` bayrakları,
SSRF koruması, URL doğrulama, "aynı ürün ≠ benzer ürün", 0.72 görsel tabanı,
arama hakkı. Bu kararla hiçbiri değişmez.

## Gerçek dağıtım doğrulaması (12 Ekim 2026, ayrı test projesi `arilla-link-queues-test`)

Doğrulandı:
- Kök dizin repo kökü iken `apps/web` (Next.js, pnpm workspace) `services` ile derlenir.
- Python service'inde `framework: "python"` açıkça verilmeli (Dockerfile ile birlikte
  "Multiple frameworks detected" hatası verir). Abone tanımları **yalnızca service
  `entrypoint`'i `pyproject.toml` ise** okunur; aksi halde abone sessizce üretilmez.
  Bu yapıda ASGI uygulaması gerekmez (abone-only service derlenir).
- Üretilen fonksiyon: `services/link/_py_subscribers/collect-link-subscriber`;
  `QUEUE_SENT` → `QUEUE_NOTIFIED` → `QUEUE_RECEIVED` (deliveryCount 1) → `QUEUE_DELETED`.
- Geçersiz yüklü mesaj abone tarafından alındı ve `kuyruk mesaji gecersiz` günlüğüyle atlandı.

Doğrulanmadı / açık: `crons` ve `maxDuration`; gerçek veritabanıyla çözümleme, SSRF
engeli, retry, tekrar teslimat, eşzamanlılık (ayrı test veritabanı gerekir); handler
döndükten sonra SDK'nın onayında `MessageNotInFlightError ... temporarily locked`
günlüğü görüldü (mesaj yine de silindi; nedeni araştırılmadı).
