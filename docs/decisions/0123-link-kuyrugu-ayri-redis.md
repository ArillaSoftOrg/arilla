# 0123 - Link kuyruğu için ayrı Redis bağlantısı (`LINK_REDIS_URL`)

**Tarih:** 15 Ekim 2026
**Durum:** Kabul edildi.

## Bağlam

Link araması VPS'te açıldığında (karar 0108) arayüz her istekte 60 sn bekleyip
"İnceleme beklenenden uzun sürüyor" gösterdi. Üretim teşhisi: web konteyneri
`REDIS_URL` ile yönetilen bir Redis'e (Upstash) bağlıydı ve `queue:link_resolution`
listesine orada yazıyordu; Python worker ise `worker.env`'deki `REDIS_URL` ile
VPS'teki yerel Redis'i (`redis:6379`) dinliyordu. Satırlar `queued` kaldı, hiçbir
hata üretilmedi, worker "healthy" göründü (sağlık denetimi yalnızca kendi Redis'ine
bakar).

Web'in Redis'i yalnızca kuyruk için değil; oran sınırı, hak pencereleri, model
bütçe tavanları, tek-uçuş kilitleri ve önbellek için de kullanılır. `REDIS_URL`'i
VPS Redis'ine çevirmek bu sayaçları sıfırlar (özellikle günlük Gemini/Jina tavanlarını)
ve başka sistemleri etkiler.

## Karar

1. Link kuyruğu için ayrı, isteğe bağlı `LINK_REDIS_URL`. `getLinkRedis()`
   (`packages/core/src/redis/client.ts`): değişken doluysa ayrı, önbellekli bir
   istemci; boşsa `getRedis()` ile aynı bağlantı (davranış değişmez; Vercel ve
   yerel geliştirme etkilenmez).
2. Yalnızca link kuyruğu bu istemciyi kullanır: `publishLinkResolution` (LPUSH) ve
   yönetim panelindeki kuyruk uzunluğu (`linkQueueDepth`, LLEN). Diğer her Redis
   kullanımı `REDIS_URL`'de kalır.
3. Güvenlik kuralları aynıdır: üretimde `rediss://` ya da `REDIS_PLAINTEXT_HOSTS`
   içindeki host'a düz `redis://`; aynı zaman aşımları; hata mesajları adres ya da
   parola taşımaz, yalnızca değişken adı. Geçersiz `LINK_REDIS_URL` sessizce
   `REDIS_URL`'e düşmez, yapılandırma hatası verir. Test çalışma zamanı uzak Redis'e
   bağlanamaz (`assertIsolatedTestEnv` bu değişkeni de denetler).
4. Python worker değişmez; `worker.env`'deki `REDIS_URL` dinlenir. VPS'te
   `LINK_REDIS_URL`, worker'ın `REDIS_URL`'i ile aynı değerdir.

## Reddedilen alternatifler

- `web.env`'de `REDIS_URL`'i yerel Redis'e çevirmek: sayaçları ve bütçe tavanlarını
  sıfırlar, Upstash'e bağlı her şeyi etkiler.
- Worker'ı Upstash'e çevirmek: link trafiği internet üzerinden, komut kotası; hedefin tersi.

## Geri alma

`web.env`'den `LINK_REDIS_URL` satırını silip `web`'i yeniden oluşturmak: kuyruk yeniden
`REDIS_URL`'e yazar. Migration yok.

## Açık / sonraki adım

Aynı hata sınıfını önlemek için worker kalp atışının Redis'e yazılıp web'in kuyruğa
yazmadan önce denetlemesi (hızlı `worker_unavailable`) ayrı bir değişiklik olarak
önerildi; bu kararın kapsamında değil.
