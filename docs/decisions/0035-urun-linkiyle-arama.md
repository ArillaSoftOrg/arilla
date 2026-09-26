# 0035 — Ürün linkiyle arama: tek kanonik rota, SSRF koruması, hibrit benzerlik

**Tarih:** 2026-09 · **Durum:** kabul edildi (arayüz QA'sı tamamlanana kadar ana sayfada "Yakında")

## Karar

1. **Tek kanonik rota: `/ara/link?url=<kodlanmış kanonik adres>`.** Üç giriş
   buraya yakınsar: arama kutusuna yapıştırma (`proxy.ts`, `/ara?q=https://…`),
   önek kısayolu (`/https://magaza.com/…`, kök catch-all yalnızca yönlendirir)
   ve ana sayfa kutusunun kodlu biçimi (`/https%3A%2F%2F…`). Kanonik olmayan
   adres (izleme parametresi, fragment) `proxy.ts`'te tek 307 ile düzeltilir.
2. **Çözümleme mevcut Katman 2 kuyruğunda kalır** (0014): web
   `link_resolution_request` satırı + Redis `queue:link_resolution`; Python
   worker getirir, çıkarır, kataloga yazar. İstek yolunda sayfa getirme ya da
   model çağrısı yoktur. Kaynak görselin embedding'ini worker üretir
   (`enrich.pipeline.embed_offer_image`, `img512-v1`, hash ile tekrar yok,
   `api_usage` yazılır).
3. **SSRF koruması worker'da, bağlantı anında.** `safe_http.GuardedBackend`
   soket açılırken host'u çözer; çözülen adreslerin HEPSİ genel olmalıdır ve
   bağlantı denetlenen IP'ye yapılır (DNS rebinding penceresi yok). Yalnızca
   http/https, kimlik bilgisi yok, portlar 80/443/8080/8443, ortam proxy'si
   yok sayılır, çerez tutulmaz. Yönlendirmeler elle, en fazla 5, her adımda
   adres + robots yeniden denetlenir. Web tarafı aynı kuralların yazım
   düzeyini savunma derinliği olarak uygular (IP literalleri tümüyle red).
4. **Sınırlı getirme:** 20 sn toplam süre, 2 MB akışla okunan gövde, yalnızca
   HTML, yeniden deneme yok, worker süreci başına tek eşzamanlı sayfa. Durum
   kodları kararlı `error_code`'a döner (`not_found`, `rate_limited`, …).
5. **Sinyaller yalnızca bulunan alanlardır** (`link_resolution_request.source`).
   Fiyat kaynak kartında yalnızca yapılandırılmış katmandan, makine biçiminde
   ve para birimiyle birlikte gösterilir. Yapılandırılmış veri "ürün" deyip
   fiyat vermiyorsa sezgisel fiyat yerine fiyatsız referans tercih edilir;
   o sayfa kataloga yazılmaz.
6. **Aynı ürün ≠ benzer ürün.** "Aynı ürün" yalnızca kimlik kanıtıyla: katalog
   adresinin kendisi (→ `/urun/<slug>`), barkod (GTIN-14'e eşitlenmiş) ya da
   aynı marka + üretici kodu. Görsel benzerlik hiçbir değerde aynılık kanıtı
   sayılmaz. Benzer ürün puanı: görsel varken 0.65 görsel + 0.25 başlık
   (pg_trgm, 0019 indeksi) + 0.10 marka; görsel yoksa 0.8 başlık + 0.2 marka.
7. **Görsel taban 0.72.** Yerel katalogdaki tüm gerçek jina-clip-v2 çiftleri:
   farklı kategori + farklı marka p90 0.650 / p99 0.742; aynı kategori +
   farklı marka p90 0.718; aynı kategori + aynı marka p50 0.748. Tabanın
   altındaki görsel komşu gösterilmez (0018: kötü alternatif, az alternatiften
   kötüdür).
8. **Önbellek:** `normalized_url` oturumlar arası anahtar. Çözülmüş sonuç 24
   sa, başarısız sonuç 10 dk hatırlanır (altyapı hataları hariç); 2 dk'dan
   eski 'queued/processing' ölü sayılır. Yeni getirme kullanıcı/oturum başına
   günde `LINK_SEARCH_DAILY_LIMIT_PER_USER` (30) ile sınırlı.

## Gerekçe

- **Neden prefix'in kendisi rota değil.** Next yoldaki `//`'yi tekilleştirir
  (`/https:/…`, 308), parçalar kodlu ya da çözülmüş gelebilir, sorgu dizesi
  Arilla'nın sorgusu olur. Bu biçim paylaşım için kırılgan; kısayol olarak
  desteklenir, kalıcı adres sorgu parametresidir.
- **Neden kanonikleştirme proxy'de.** `/ara/loading.tsx` sayfayı akışa sokar;
  sayfa içindeki `redirect()` 200 + istemci yönlendirmesine döner (QA'da
  ölçüldü). Proxy gerçek bir 307 verir.
- **Neden IP denetimi bağlantı anında.** Önce çöz-sonra getir iki DNS sorgusu
  yapar; ikincisi iç adrese dönebilir. Denetlenen IP'ye bağlanmak bu pencereyi
  kapatır; TLS yine gerçek host adıyla doğrulanır.
- **Neden `www.` artık getirilen adreste kalıyor.** Kimlik (`domain`,
  `external_id`) değişmedi; ama apeks alan adı çözülmeyen mağazalarda eski
  davranış sayfayı hiç getiremiyordu.
- **Neden bilinen ürün araması yol karşılaştırması da yapıyor.** Feed/Shopify
  offer'larının `external_id`'si mağazanın kendi kimliğidir; yalnızca URL'den
  türetilen kimliğe bakınca katalogdaki ürünün linki bulunamıyor, yeniden
  getirilip kopya offer açılıyordu (QA'da bulundu).

## Reddedilen alternatifler

- **Next istek yolunda senkron sayfa getirme.** Kolay ama iki servisi senkron
  bağlar, SSRF yüzeyini web sürecine taşır, istek süresini dış siteye bağlar.
- **Sayfayı tarayıcı otomasyonuyla getirmek.** Bot korumasını aşma aracına
  dönüşür; robots ve 0004 ile çelişir.
- **Metni LLM ile yorumlamak.** v1'de gereksiz; yapılandırılmış veri + pg_trgm
  + görsel yeterli. Gelecekte başlık sadeleştirmede değerlendirilebilir.
- **Görsel benzerliği tabansız kullanmak.** QA'da ilgisiz ürünler (nevresim,
  şampuan, klavye) en üste çıktı: gerçek vektörlü katalog küçükken en yakın
  komşu da ilgisizdir.

## Sonucu / açık işler

- Fiyatsız referans sayfanın görseli embed edilmez (bağlanacak offer yok);
  arama metinle yürür.
- Kaynak `category` metni katalog ağacına eşlenmiyor; sıralamada kullanılmıyor.
- Görsel sinyalin gücü katalogdaki gerçek vektör sayısına bağlı (yerelde 340
  ürün). Taban, katalog büyüdükçe yeniden ölçülmelidir.
- Worker, `python -m collect.link --worker` ile ayrı süreç olarak çalışmalı;
  anahtar yoksa görselsiz (metinle) çalışır.
