# 0079 — Sohbette ürün linki

**Tarih:** 8 Ekim 2026
**Durum:** Kabul edildi, kod hazır; `CHAT_LINK_ENABLED=true` (ve `CHAT_DISCOVERY_ENABLED=true`)
verilene kadar kapalı. Gemini'li tercih yorumu ayrıca `CHAT_LINK_INTERPRET_ENABLED=true`
ister, varsayılan kapalı. Link worker'ı üretimde çalışmadan açılmaz.

Ürün linki bugün yalnızca `/ara/link` rotasında çözülüyor (0035) ve o rota geçici olarak
"Yakında" (`LINK_SEARCH_PUBLIC=false`, #67/#68). Sohbette link modele gitmediği için
(0074) düz metin sorgusuna düşüyordu. Karar: sohbet, mevcut link hattının üstüne ince bir
yönlendirme olur; yeni arama sistemi yoktur. `/ara/link` ve `LINK_SEARCH_PUBLIC`
bu kararla değişmez.

## Karar

1. **Link modelsiz çözülür.** Mesajın herhangi bir yerindeki `https?://` ve `www.`
   bağlantısı ayıklanır, `checkLinkSearchUrl` ile doğrulanır. Geçerli ilk link mevcut
   `link_resolution_request` + Redis kuyruğu + Python worker hattına gider (0014/0035).
   TS↔Python sınırı aynıdır: yalnızca PostgreSQL ve Redis. Link modele ASLA gitmez;
   0074'teki "bağlantı içeren mesaj modele gitmez" kuralı korunur, "ayrı yoldan çözülür"
   ifadesinin karşılığı budur.
2. **Sonuç mesajda kalıcıdır, ürünler değil.** Asistan `notice` mesajı `payload.link`
   taşır (`requestId`, `normalizedUrl`, `remainderText`, `preferences`). Yeni mesaj türü ve
   migration yok (0054 CHECK'i korunur). Görüntüleme `requestId` ile okunur (URL'nin 24
   saatlik cache penceresiyle değil); sayfa yenilense de sonuç aynıdır. Ürünler görüntüleme
   anında `findLinkSearchResults` ile, mevcut kartlarla gelir; fiyat/stok taze kalır.
3. **Fiyatsız kaynakta da görsel benzerlik.** Worker, fiyatsız referans sayfanın görselini
   de embed eder: güvenli indirme + önişleme (`img512-v1`), `image_upload` (ham görsel
   saklanmaz) + `embedding(target_type='query')`, `link_resolution_request.image_embedding_id`.
   Aynı hash için embedding varsa Jina çağrılmaz (`api_usage.cache_hit`). Offer, `price_point`
   ve `product` yazılmaz; fiyat/stok uydurulmaz. Görsel yoksa/başarısızsa arama metinle sürer
   ve sohbet bunu söyler.
4. **Tercihler önce deterministik.** URL'nin yanındaki fiyat, "daha ucuz", renk, stil ve
   malzeme sözcükleri mevcut fiyat dili ve lexicon ile `LinkPreferences`'a çevrilir.
   `findLinkSearchResults` bunları yalnızca katalogda gerçekten bulunan alanlarla uygular
   (`product.color`, `product.attributes`, fiyat); veri yoksa tercih `unapplied` olarak
   bildirilir, özellik uydurulmaz. Görsel taban (0.72) ve "aynı ürün yalnızca kimlik
   kanıtıyla" kuralı korunur; kimlik kanıtlı aynı ürün tercihle elenmez. Kategori kapısı
   yalnızca kaynak kategori lexicon'da tek hatta eşleşiyorsa uygulanır.
5. **Süreklilik.** Referans, konuşmadaki en son link mesajı (ya da görselli mesaj). Link
   referansı varken gelen URL'siz, görselsiz ve tanınan tercih içeren mesaj bir iyileştirme
   turudur: model yok, yeni getirme yok, aynı `requestId`, tercihler birleşir (yeni fiyat
   eskisini değiştirir, renk ve stil yer değiştirir, `sort` kalıcıdır, "fiyat sınırını
   kaldır" fiyatı temizler). Yeni link ya da görsel referansı değiştirir ve tercihleri
   sıfırlar; araya normal bir `search`/`clarify` cevabı girerse referans düşer.
6. **Gemini yalnızca gerektiğinde (beşinci istisna, CLAUDE.md kural 1).** Her link
   aramasında çağrı yok. Çağrı yalnızca `CHAT_LINK_INTERPRET_ENABLED` açıkken ve
   deterministik ayrıştırma sonrası tanınmayan anlamlı sözcük kaldıysa ("daha spor",
   "ofiste giyebileceğim") yapılır; takipte ek olarak mesaj kısa olmalı ve marka/kategori/
   beden içermemelidir. Modele giden: URL'si ayıklanmış kullanıcı metni ve önceki URL'siz
   kullanıcı mesajları. Sayfa başlığı/metni/görseli ve asistan mesajları gitmez (prompt
   injection yüzeyi). Çıktıdan yalnızca lexicon ile doğrulanan renk, stil/malzeme, fiyat ve
   `sort` alınır; `query`, `category`, `brand`, beden ve serbest öznitelikler atılır; URL
   içeren çıktı ya da metinde olmayan fiyat reddedilir. Çağrı mevcut hattan geçer:
   `api_usage` (`CHAT_TURN_OPERATION`), günlük tavan, kullanıcı saatlik tavanı; hiçbir limit
   değişmedi. Hata/zaman aşımı/tavan: tanınan tercihler uygulanır, "tercihini tam
   anlayamadım" notu eklenir.
7. **Hata asla çıkmaz yol bırakmaz.** Her durum sohbette anlaşılır bir mesajdır ve sonraki
   adımı söyler (ürün fotoğrafı yükle — yalnızca `CHAT_IMAGE_ENABLED` açıksa — ya da kısaca
   tarif et): geçersiz/engelli bağlantı, `robots_disallowed`, `access_denied`, `not_found`,
   `no_product`, `unsupported_content`, `too_large`, `rate_limited`, `upstream_error`,
   worker yanıt vermedi (`stale`: 2 dk), kuyruk/Redis yok, görsel kullanılamadı (metinle
   arandı), benzer ürün yok, hak/hız engelleri. Bot korumalı siteler (Akamai vb.)
   aşılmaz: 0035 "tarayıcı otomasyonu" maddesi geçerlidir.

## Arama hakkı ve kota (kapsam dışı, davranış değişmedi)

Hak sistemi bu kararın kapsamı dışındadır. Sohbet, link çözümü için mevcut
`runChargedLinkSearch`'ü olduğu gibi çağırır; hak tüketimi, cache isabetinin ücretsizliği,
idempotency, iade ve uzlaşma (`reconcileLinkRequestCharge`, `/ara/link` ile aynı koşul ve
çağrı noktası) değişmez. İstek anahtarı `conversationId + kullanıcı mesaj seq` ile
deterministiktir; aynı tur yeniden işlenirse hak ve istek satırı ikilenmez.

**Sonuç — 0074 ve 0078'deki "sohbet turları hak harcamaz" cümlesi link turu için
geçerli değildir:** yeni bir link çözümü, `/ara/link`'teki gibi hak harcar; önbellekteki
link harcamaz. İyileştirme turları ve normal sohbet turları harcamaz. Bunu değiştirmek ayrı
bir ürün/hak kararıdır. Aynı kullanıcıda aktif bir link araması sürerken ikinci yeni link
`reserveSearch`'ün mevcut davranışıyla `busy` olur.

## Gerekçe

- **Worker'a dokunmadan sohbet.** İstek yolunda sayfa getirme ya da model çağrısı yok; SSRF
  yüzeyi worker'da kalır.
- **Mesaj türü yerine `payload.link`.** CHECK değişikliği migration ve çok adımlı dağıtım
  ister (kural 14); `notice` yükü yeterlidir.
- **Önce deterministik.** Tercihlerin çoğu fiyat/renk/"daha ucuz"dur; Gemini yalnızca kalan
  belirsiz anlam için, maliyet kullanıcı mesajıyla orantılı ve tavanlıdır.
- **Kimlik kanıtı + görsel taban korunur.** Alakasız ürünle doldurmak, az göstermekten
  kötüdür (0018, 0035).

## Reddedilen alternatifler

- **İstek yolunda sayfayı getirmek ya da sayfa metnini LLM'e vermek.** 0035 reddi; ayrıca
  üçüncü taraf içeriği komut enjeksiyonu taşır.
- **Her link için Gemini.** Gereksiz maliyet; basit linkler deterministik çözülür.
- **Yeni `chat_message.kind = 'link'`.** Migration + CHECK genişletme; yük alanı yeterli.
- **Tercihi `SearchIntent`'e çevirip metin aramasına vermek.** Görsel benzerlik ve kimlik
  kanıtı kaybolur.
- **Hak politikasını sohbet için değiştirmek.** Kapsam dışı; ayrı karar.

## Açık işler

- `product.attributes` anahtarları şemada sabit değil; stil/malzeme için yalnızca `style(s)`
  ve `material(s)` okunur. Gerçek katalogda başka ad varsa tercih `unapplied` kalır.
- Bot korumalı mağazalarda (örn. Zara, H&M) link çalışmaz; çözüm fotoğraf ya da tarif.
  Amazon'da JSON-LD/OG yok, sezgisel katman kullanılır ve fiyat göstermez.
- Fiyatsız kaynak embedding'leri (`image_upload` + `query` embedding) için retention işi yok;
  30 günlük temizlik yalnızca ham dosyayı siler.
- Görselli mesajda URL varsa link dalı atlanır (0078 aynen).
- Görsel tabanı katalog büyüdükçe yeniden ölçülmelidir (0035).
- Hukuk: Gemini'ye giden yalnızca kullanıcının kendi URL'siz metnidir; yeni veri kategorisi
  yoktur. `docs/legal-review/sohbet-konusmali-kesif.md` kapsamı geçerlidir.
