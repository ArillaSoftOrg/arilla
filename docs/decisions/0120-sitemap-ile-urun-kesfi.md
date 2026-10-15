# 0120 — Hepsiburada: sitemap ile ürün keşfi, ilk aktarım ve haftalık yenileme

**Tarih:** 15 Ekim 2026
**Durum:** Kabul edildi (migration 0074). Kod ve testler hazır. `discovery_source_policy.enabled = FALSE`
gelir; zamanlayıcı yoktur. Gerçek aktarım sahip rolün politikayı açmasını ve yöneticinin
kendi tarayıcısından başlatmasını ister.
**İlgili:** 0117 (yönetici tarayıcısından toplama, kota defteri), 0119 (yalnız kesin kimlikle
birleştirme), 0111 (güvenli deaktivasyon).

## Bağlam

Hepsiburada ürün sitemap indeksi (2026-10-15 ölçümü) ~7.470 dosya listeler; her dosya
~10.000 ürün adresi, görsel adresi ve görsel başlığı taşır (fiyat, marka, kategori yok). Dosya
başına 9–12 MB açık metin, toplam ~78 GB. Sunucudan (VPS) doğrudan erişim 403 döner; yönetici
tarayıcısından erişim çalışır. İlk hedef en az 8 milyon benzersiz ürün; bu bir durma koşulu
değildir.

## Kullanıcı kararları (2026-10-15)

1. Önce kimlik, ad, görsel ve adres toplanır; fiyat sonra tamamlanır.
2. **İlk kapsamlı aktarım haftalık yenilemeden ayrıdır** ve haftalık kota hakkı harcamaz.
   Bu, 0117'deki "ilk yükleme kotadan muaf değildir" notunu **yalnızca sitemap keşfi için**
   değiştirir. Dayanak kullanıcı beyanıdır; izin yazışmaları bağımsız incelenmemiştir.
   0070'in `initial_load_exempt` CHECK'i ve liste toplayıcının kotası DEĞİŞMEZ.
3. Haftalık yenileme: en az 7 gün aralık, takvim ayında en fazla 4 operasyon. Bir operasyon
   içindeki her sitemap dosyası ayrı hak sayılmaz.
4. Başarısız koşu #1 ve kota defteri silinmez, değiştirilmez.
5. Mobil veriyle büyük aktarım başlatılmaz; production verisine dokunulmaz.

## Karar

### Veri modeli (0074)

- `catalog_discovery`: fiyatsız keşif defteri. Doğal birincil anahtar `(source, external_id)`;
  tekrar keşif yeni satır üretmez. `offer` değildir, **fiyat kolonu yoktur**. Alanlar: ürün
  kodu (`-pm-`/`-p-`), adres yolu, görsel başlığı (yoksa NULL; adresten ad uydurulmaz), görsel,
  ilk/son görülme (zaman + operasyon + dosya), ardışık görülmeme sayısı, varlık durumu,
  fiyat **durumu** (`unpriced/verified/stale/unavailable`, değer değil) ve yayın durumu.
  Ek indeks yok (PK yeterli; toplu işler PK aralığıyla ilerler); `fillfactor=85` ile haftalık
  "son görülme" yazımı HOT güncellemedir. Panel sayıları `catalog_discovery_tally`den okunur
  (milyonlarca satırda `count(*)` istek yolunda çalışmaz).
- `catalog_sync_operation`: `initial_import` | `weekly_refresh`. Yenileme, operasyon başına
  **tek** `collection_run` satırı rezerve eder (0070 tetikleyicisi aralık/ay kuralını zorlar).
  İlk aktarım `collection_run` yazmaz. Kaynak başına tek etkin operasyon ve iptal edilmemiş tek
  ilk aktarım (kısmi benzersiz indeksler). Bütçe ve süre tetikleyiciyle politikadan yazılır;
  kapanan operasyon yeniden açılmaz.
- `catalog_sync_unit`: dosya bazında checkpoint (seq 0 = indeks). Kesintide kalan dosyadan
  devam edilir; yarım kalan dosya yeniden denenir (deneme hakkı politikadan).
- `catalog_sync_request`: append-only istek defteri; istek aralığı ve kayan 24 saat tavanı
  buradan hesaplanır.
- `discovery_source_policy`: istek aralığı (≥2 sn, varsayılan 5 sn), günlük tavan (2.500),
  operasyon başına istek (8.000) ve açılmış bayt (100 GiB) bütçesi, dosya deneme hakkı, engel
  bekleme süresi (24 sa), kaldırma eşiği (≥2 ardışık tam tarama), hedef göstergesi (8M).
  Uygulama rolü yalnızca okur.

### İstemci ve sunucu sorumlulukları

- **Tarayıcı (yönetici, kendi bağlantısı):** her kaynak isteğinden önce sunucudan hak alır,
  dosyayı çerezsiz indirir, akışla açar (HTTP `Content-Encoding` tarayıcıda; dosyanın kendisi
  `.gz`/`.br` ise `DecompressionStream`) ve akışla ayrıştırır; dosya belleğe toptan alınmaz.
  Kayıtları 1.000'lik partilerle gönderir. 401/403/429/503, HTML/doğrulama sayfası ya da
  beklenen yapının yokluğu engeldir: bildirilir, operasyon durur, yeniden denenmez. Ağ hatası
  engel kanıtı değildir: dosya hatalı işaretlenir, oturum durur, operasyon açık kalır.
  Büyük aktarım varsayılan kapalıdır: onay kutusu + Wi-Fi/kablolu beyanı gerekir; tarayıcı
  mobil veri/veri tasarrufu bildirirse başlamaz. Oturum başına dosya sınırı vardır.
- **Sunucu:** hak verirken aralığı, günlük tavanı, istek/bayt bütçesini ve istemci kirasını
  zorlar; her kaydı yeniden doğrular (kimlik yoldan yeniden çıkarılır, alan adları sınanır,
  fiyat alanı kabul edilmez) ve PK ile upsert eder. Kira 2 dakikada tazelenmezse panel
  "çalışan istemci yok" der; başka sekme ancak **açıkça** devralır.
- **Python (toplu):** `feeds discovery-publish` (kalite koşullu, sınırlı sayıda fiyatsız teklif
  açar), `feeds discovery-finalize` (tam haftalık taramadan sonra kaldırma), `hb-merge`
  sonrası fiyat bağlama.

### Fiyat tamamlama

Keşif ile fiyat ayrıdır. Doğrulanmış fiyat yalnızca mevcut liste toplayıcısı → ara depo →
`hb-merge` → `offer`/`price_point` hattından gelir. `hb-merge` sonrası aynı **ürün koduna**
sahip defter satırı `verified` olur ve teklife bağlanır (`price_offer_id`, kaynak, gözlem
zamanı). Kod birebir eşit değilse bağlanmaz: ad benzerliğiyle eşleştirme yapılmaz. 14 günden
eski doğrulama `stale` olur ve güncel sayılmaz. Bu görevde toplu fiyat toplama yoktur.

### Yayınlama ve ürün sayfaları

`discovery-publish` yalnızca başlığı ≥10 karakter, görseli olan, şu an kaynakta görülen
kayıtları `current_price = NULL` teklif olarak açar (aynı kodlu teklif varsa ona bağlanır).
Fiyat karşılaştırması ve ürün sayıları fiyatsız teklifi zaten saymaz. Ürün eşleştirmesi
çözümleyicinin işidir (0119: yalnızca kesin kimlikle birleşme). Mevcut `/urun/[slug]`
dinamik sayfası kullanılır; fiyatsız üründe fiyat gösterilmez, "Fiyat henüz doğrulanmadı"
yazılır ve mağazaya çıkış `/git` ile `click` üretir. Statik HTML üretilmez.

### SEO

Hepsiburada sitemap'leri keşif içindir; ManiCepte sitemap'i kendi sayfalarımızı bildirir.
Mevcut kural (≥2 teklif ya da 14 günlük fiyat geçmişi) aynen kalır. Fiyatsız ürün yalnızca
`SEO_UNPRICED_PRODUCTS_ENABLED=true` iken ve açık kriterlerle girer: marka var, başlık ≥15
karakter, ≥3 teknik özellik, son 14 günde görülmüş aktif teklif. Yalnızca ad + görsel yetmez.
Kaldırılan ürünün teklifi pasifleşir; sayfa yayında kalır, haritadan düşer, `noindex` alır.

### Kaldırma

Bir ürün yalnızca politikadaki sayıda (≥2) **ardışık TAM** haftalık taramada görülmezse
`removed` olur. Tam tarama: tüm dosyalar işlendi, hatalı dosya yok ve planlanan dosya sayısı
önceki tam taramanın %95'inden az değil. Yarım, iptal edilen ya da süresi dolan tarama hiçbir
ürünü etkilemez. Defterden satır silinmez.

## Reddedilen alternatifler

- **Keşfedilen her ürünü hemen `offer` yapmak:** 8M fiyatsız teklif `offer` indekslerini ve
  çözümleyiciyi şişirir; yayın kalite koşullu ve sınırlı toplu iştir.
- **Her sitemap adresini ürün sayfası isteğine çevirmek:** istek hacmini 10.000 kat artırır;
  izin kapsamı dışında. Yapılmaz.
- **VPS'ten indirme / proxy / IP rotasyonu:** 403 alınıyor; erişim kontrolü aşılmaz.
- **İlk aktarımı haftalık kotaya saymak:** 7.470 dosya 500 istek/hafta bütçesiyle aylar sürer
  ve kullanıcı kararı bunun tersidir.
- **Panelde 8M'yi tamamlanma yüzdesi göstermek:** sitemap'in tamamı bilinmez; hedef göstergesi
  olarak sayı/hedef yazılır.

## Bilinen sınırlar

- Sitemap dosyalarının tarayıcıdan **CORS** ile okunabildiği doğrulanmadı (`/ara` için
  doğrulanmıştı); bu görevde Hepsiburada'ya istek atılmadı. Okunamazsa operasyon ağ hatasıyla
  durur ve açık kalır.
- Sitemap kodu (`-pm-HBC…`) ile liste/JSON-LD kodu (`-p-HBCV…`) farklı ad alanlarıdır; fiyat
  bağlama yalnızca birebir aynı kodda olur. Liste toplayıcının çoğu kaydı sitemap ürününe
  bağlanmayabilir; bu kapsam açığı ölçülmelidir.
- Açılmış bayt istemci beyanıdır; aktarılan bayt yalnızca `Content-Length` biliniyorsa sayılır.
- ~8M satır için tahmini disk: tablo ~3 GB + PK ~0,5 GB; her tam yenileme ~8M HOT güncelleme
  (~1 GB WAL).
