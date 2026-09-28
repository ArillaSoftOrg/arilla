# 0042 — Shopify toplamasında robots.txt, kimlik ve aktivasyon yasağı

**Tarih:** 2026-09
**Durum:** kabul edildi (kod ve çevrimdışı testler hazır; canlı koşu yapılmadı,
hiçbir merchant aktifleştirilmedi)

## Bağlam

`0032`'nin hazırlık doğrulaması robots.txt'i katı yorumluyor, kendini
`ArillaBot` olarak tanıtıyor ve yönlendirme izlemiyordu. Gerçek toplama ise
bunların hiçbirini yapmıyordu:

- `ShopifyConnector` varsayılan `python-httpx` kimliğiyle ve yönlendirme
  izleyerek istek atıyordu.
- `run_ingest` hiçbir aşamada robots.txt sormuyordu; `Crawl-delay`
  uygulanmıyordu.
- `collect.bootstrap` her kayıtta `is_active = TRUE` yazıyor (yeni satırda da,
  alan adı çakışmasında da), `feed_config`'i bütünüyle değiştiriyor ve hemen
  ardından toplamayı başlatıyordu. `0021` ile para birimi doğrulanan 18
  merchant'ın 7'si bootstrap manifestinde aynı alan adıyla duruyor; tek bir
  bootstrap koşusu onları onaysız aktifleştirip `0032`'nin incelediği eşlemeyi
  ezerdi.

Böylece READY kararı gerçek koşunun davranışını temsil etmiyordu ve
aktivasyonun "ayrı, onaylı adım" olması bootstrap ile atlanabiliyordu.

## Karar

**1. Bootstrap aktivasyon yapmaz.**

- Yeni merchant `is_active = false` eklenir. Mevcut merchant'ın `is_active`'i
  hiç yazılmaz (UPDATE'te kolon yok).
- `--register-only` dahil hiçbir mod aktifleştirmez.
- Pasif merchant için `run_ingest` çağrılmaz; rapor `inactive` der, mağazaya
  istek gitmez. Kapı (`0031`) zaten reddederdi; bootstrap `ingest_run`
  satırı bile açmadan durur.
- `feed_config` bütünüyle değiştirilmez: mevcut anahtarlar kalır, manifest
  anahtarları üstüne yazılır; kayıtlı `currency`, `currency_verified`,
  `currency_evidence` hiç değişmez (manifestin kanıt dosyası yalnızca eksikse
  doldurur).
- `currency_verified = true` olan merchant'ın yapılandırması güvenilirdir:
  manifestten farklıysa (anahtar, `feed_url` ya da para birimi kanıtı) kayıt
  **reddedilir** (`refused`, farklı anahtarlar raporda), satır değişmez,
  toplama yapılmaz. Böyle bir değişiklik `packages/db` migration'ıdır.
- Kaynak türü `shopify` olmayan mevcut satır da reddedilir.
- Çıkış kodu: normal koşuda yalnızca tümü `success` ise 0; `inactive` ve
  `refused` başarı değildir.

**2. Kimlik ve istemci.** `ShopifyConnector`'ın varsayılan istemcisi
`safe_http.guarded_client(user_agent=USER_AGENT, follow_redirects=False)`:
SSRF korumalı, çerezsiz, proxy'siz; zaman aşımı 60 sn (bağlantı 10 sn).
Ayrıca her istek `User-Agent: USER_AGENT` ve `follow_redirects=False`'u
**istek düzeyinde** taşır — enjekte edilmiş bir istemci farklı kurulmuş olsa
bile. 3xx bir hatadır ve yeniden denenmez. Yeni yeniden deneme eklenmedi;
katalog sayfası için mevcut, yapılandırmaya bağlı sınırlı deneme (`0027`)
aynen kalır.

**3. Çalışma anında robots.txt, katı ve önce.** İlk `/products.json`
isteğinden önce, koşu başına **tek** `GET https://<alan-adı>/robots.txt`
(aynı istemci, aynı user-agent, yeniden deneme yok, yönlendirme izlenmez,
10 sn). Yorum `collect/robots_policy.py`'dedir ve hazırlık doğrulaması aynı
kodu kullanır:

| Yanıt | Sonuç |
| --- | --- |
| 200 `text/plain` (ya da Content-Type yok), izin | devam |
| 404 | kural yok, devam (repo sözleşmesi) |
| yol yasak / bizim gruba uyan joker yasak | `refused:robots_disallowed` |
| 3xx, 401/403, 5xx, diğer; zaman aşımı, ağ hatası, okunamayan gövde, başka Content-Type | `refused:robots_unavailable` |
| `Crawl-delay` > 30 sn | `refused:robots_crawl_delay_too_long` |
| `feed_url` https değil ya da kimlik bilgisi içeriyor | `refused:feed_url_invalid` |

**4. Sorgu biçimi.** Denetlenen yollar sabit bir örnek değil, connector'ın
gerçek istekleridir (`ShopifyConnector.robots_paths()`): `/products.json`,
`/products.json?page=1&limit=<gerçek sayfa boyu>` ve sayfalama mümkünse
`page=2`. Hazırlık doğrulaması kendi sabit yollarına merchant'ın bu gerçek
yollarını **ekler** — READY daha zor, asla daha kolay olmaz.

**5. Crawl-delay.** Geçerli bir `Crawl-delay` istekler arası en kısa süredir;
yapılandırılmış oran sınırıyla birlikte hangisi daha yavaşsa o uygulanır.
robots isteği de sayılır: ilk katalog isteği aynı aralığı bekler. Eşik
(`MAX_CRAWL_DELAY_SECONDS = 30`) tek yerde tanımlı; hazırlık doğrulaması
aynı eşikte örneği atlar (REVIEW), gerçek toplama reddeder — beklemeye
girmez.

**6. Ret sözleşmesi.** Connector reddi `collect.gate.IngestRefused`'dır;
`run_ingest` onu kapı reddiyle aynı biçimde kaydeder: `ingest_run`
`failed`, `error_text` `refused:<kod>: ...`, sayaçlar sıfır, işlem geri alınır,
`IngestResult.refusal` dolu, yakalanmamış hata yok. Veritabanı kapısı
(`is_active`, `currency_verified`, TRY) önce sorulur ve değişmedi.

## Reddedilen alternatifler

- **`link/robots.RobotsCache`'i kullanmak.** Kullanıcı linki için bilinçli
  olarak gevşek: ağ hatasında ve 5xx'te izin verir, yönlendirmeyi izler. Toplu
  toplamada "belirlenemedi" izin anlamına gelemez (`0032` aynı nedenle
  reddetmişti).
- **Robots kontrolünü `pipeline.py`'ye koymak.** Boru hattı kaynak
  bağımsızdır; gerçek istek biçimini (sayfa boyu, sorgu) yalnızca connector
  bilir.
- **Hazırlık doğrulamasına ayrı bir robots yorumu bırakmak.** İki yorum
  zamanla ayrışır; READY gerçek koşuyu temsil etmez.
- **Bootstrap'ın doğrulanmış merchant'ı "yalnızca eşleme" ile güncellemesi.**
  `0032` tam da o eşlemeyi inceliyor; değişiklik onaylı migration olarak kalır.

## Açık konular (bu kararın dışında)

- Yönetim konsolundan aktivasyon (`setMerchantActive`) hazırlık raporuna
  bakmıyor.
- Bu değişiklikten önce bir yerel veritabanında bootstrap ile aktifleşmiş
  merchant'lar aktif kalır; bootstrap `is_active`'e artık dokunmadığı için
  onları da kapatmaz.
- Kullanıcı linki yolunun kapı ve para birimi davranışı ayrıca ele alınacak.
