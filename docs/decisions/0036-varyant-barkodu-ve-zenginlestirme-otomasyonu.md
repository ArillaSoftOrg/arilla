# 0036 — Varyant düzeyinde barkod ve zenginleştirme otomasyonu

**Tarih:** 2026-09
**Durum:** kabul edildi

## Sorun

Tek bir offer birden fazla ticari varyant taşıyabilir. Örneğin Korendy'de
aynı mist'in 60 ml ve 100 ml'si tek offer'ın iki `offer_variant` satırıdır.
Her boyutun barkodu farklıdır. 0034 barkodu yalnızca offer düzeyinde
(`attributes_raw.gtin`) tutuyordu ve "gruptaki tek geçerli barkod" kuralı,
barkodsuz boyutu yok sayıp 100 ml'nin barkodunu 60 ml'yi de içeren offer'a
yazıyordu. Bu yanlış kimlik iki çifti kaçırıyordu, birinde yanlış bir barkod
vetosu da üretiyordu.

## Karar

**Model.** Barkod ticari varyantın kimliğidir ve sahibinin satırında durur:

| Düzey | Yer | Ne zaman |
|---|---|---|
| varyant | `offer_variant.gtin` + `gtin_source` (migration 0022) | her boyutun kendi barkodu |
| offer | `offer.attributes_raw.gtin` + `gtin_source` | yalnızca offer tek ticari varyantsa: gruptaki **her** varyant aynı geçerli barkodu taşıyor |
| ürün | `product.gtin` | ürünün offer'larındaki tek tutarlı offer barkodu; çelişkide NULL |

`sku` 0017'de aynı gerekçeyle `offer_variant`'a eklenmişti. `attributes_raw`
içinde varyant kimliğine göre JSON tutmak düşünüldü ve reddedildi (aşağıda).

**Eşleme anahtarı** (`/products/<handle>.js` → `offer_variant`): önce varyant
kimliği (`external_id` = Shopify varyant id), sonra SKU, sonra beden seçeneği
değeri. Birden fazla varyanta uyan zayıf anahtar kullanılmaz. **Dizi sırası
hiç kullanılmaz.**

**Köken.** Değer (`gtin`), tür (uzunluktan GTIN-8/12/13/14), kaynak
(`gtin_source`: `feed` / `products_js` / `sku`), doğrulama (GS1 kontrol
basamağı yazımdan **önce** zorunlu; geçersiz değer hiç saklanmaz, eşleştirmeye
giremez), zaman (`attributes_raw.identifiers_checked_at`).

**Eşleştirme** (`resolve/identifiers.py`):

- Kesin eşleşme = aynı geçerli barkod + uyumlu ticari varyant (hacim iki
  tarafta biliniyorsa eşit) + marka/renk/kademe vetosu yok. Varyant düzeyi
  barkod `offer_variant.gtin_idx` üzerinden aranır.
- Barkodla kanıtlanan eşleşme **aynı merchant dışlamasından muaftır**. Aynı
  mağazanın 60 ml ve 100 ml'yi ayrı listelemesi aynı ürünün iki boyutudur.
- Barkod kümesi **tam** olan aday (her aktif offer'ı ya offer düzeyinde ya da
  tüm varyantlarında barkodlu) offer'ın barkodunu içermiyorsa elenir. Offer o
  ürünün hiçbir ticari varyantı değildir.
- İki farklı geçerli offer barkodu vetosu (0034) sürer.

**Otomasyon.** C seçeneği (ikisi birden, artımlı):

- `python -m collect.bootstrap` her mağazanın toplamasının hemen ardından aynı
  sıralı akışta `identifiers.enrich_merchant` çağırır. Hata toplamayı
  düşürmez: rapora yazılır, sıradaki mağazaya geçilir. `--skip-identifiers`
  ile kapatılır.
- `python -m collect.identifiers --merchant …` bağımsız, sınırlı iş. Tazelik
  önbelleği sayesinde tekrar çalıştırmak ucuzdur (7 gün içinde kontrol edilen
  offer istenmez; `--force`).

Neden ikisi: "birden fazla mağazada görülen marka" koşulu, ilk toplanan
mağazada henüz karşı tarafı göremez. Bağımsız iş sonradan eklenen mağazalarla
kapsamı tamamlar.

**Üretimde zamanlama (henüz kurulmadı).** Python worker ayrı barındırmada
çalışır (docs/ops.md). Önerilen: gece toplama işinin ardından aynı worker'da
sıralı `collect.identifiers`, sonra `resolve`, sonra `enrich`, sonra
`similarity`. Tek eşzamanlılık ve mağaza başına istek tavanı. Vercel cron'u
kullanılmaz: TypeScript Python'u çağırmaz (CLAUDE.md).

**Kaynak güvenliği.** robots.txt dinlenir. Sıralı, ≤ 0,5 istek/sn ya da
sitenin Crawl-delay'i. Yeniden deneme yok. 401/403/429 ya da robots yasağında
mağaza hemen durur. Arka arkaya 3 sunucu/bağlantı hatasında durur.

## Barkodsuz mağazalar

Barkod uydurulmaz. Sasha gibi kaynaklar marka + ticari çekirdek başlık +
hacim/renk uyumu + inceleme kuyruğu yolunda kalır. AUTO_ACCEPT genel olarak
gevşetilmedi.

## Reddedilen alternatifler

- **`attributes_raw.variant_gtins` JSON'u.** İndekslenemez (her eşleştirmede
  offer tablosu taranır). Varyantın silinmesi/yenilenmesiyle yaşam döngüsü
  ayrışır. Varyant verisinin sahibi zaten `offer_variant`.
- **Offer'ı boyutlara bölmek.** 0005 bedeni ürün değil varyant sayıyor;
  toplama sözleşmesi (1 kayıt → 1 offer) değişirdi.
- **Dizi sırasıyla eşlemek.** Mağaza varyant sırasını değiştirince sessizce
  yanlış barkod yazılırdı.
