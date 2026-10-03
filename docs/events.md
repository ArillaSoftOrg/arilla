# Analitik olayları

Olay isimleri burada tanımlanır. Tanımsız olay gönderilmez; aksi halde her
ekranda farklı isim üretilir ve altı ay sonra veri işe yaramaz hale gelir.

## İsimlendirme

`nesne_fiil`, küçük harf, alt çizgi, geçmiş zaman yok.
Doğru: `search_submitted`. Yanlış: `SearchSubmitted`, `user_searched`, `search`.

Her olay şu ortak alanları taşır: `session_id`, `user_id` (varsa), `channel`
(`web` | `mcp` | `extension`), `ts`.

## Olay sınıfları ve rıza

`docs/decisions/0049` §4. Bu dosyadaki her olay aşağıdaki iki sınıftan
birindedir. Sınıf olay tanımıyla birlikte sabittir, çağıran kod
değiştiremez.

| Sınıf | Nereye yazılır | Rıza | Olaylar |
| --- | --- | --- | --- |
| **Hizmet / güvenlik** | `auth_event` ve domain tabloları | gerekmez | `login_completed`, `logout_completed`, `session_revoked`, `consent_changed` |
| **Davranışsal analitik** | `user_activity_event` (tek core kapısı `recordActivity`, 0049 §7) | **analitik rızası** | `search_submitted`, `product_viewed`, `merchant_exit` |

Bu tablodaki sınıfların kuralları:

- Hizmet olayları rıza durumundan bağımsızdır, geri almada silinmez.
- Analitik olayları yalnızca girişli kullanıcı için ve analitik rızası
  açıkken yazılır. Rıza yoksa ya da bilinmiyorsa hiçbir şey yazılmaz:
  sayaç artmaz, anonim yedek kayıt tutulmaz.
- Analitik rızası geri alınınca kullanıcının analitik olayları silinir.
- Analitik olayları 180 gün saklanır; `query_norm` 90 günde silinir.
- Tekrar bastırma: aynı normalize sorgu 10 dakika, aynı ürün 30 dakika
  içinde ikinci kez yazılmaz. Her mağaza çıkışı ayrı bir olaydır.
- `item_saved`/`item_unsaved` ve `alternative_clicked` tanımlıdır ama
  **yazılmaz** (0049 §4): kaydetme durumu `saved_item`'dadır; alternatif
  listesi ayrı bir çıkış üretmez.
- Yukarıdaki tabloda olmayan olaylar (arama ayrıntıları, creator, keşfet,
  alarm) bugün **hiçbir yere yazılmaz**. Yazılacakları zaman önce buraya
  sınıfları eklenir.

`search_query_day` (0052, 0054) bir olay **değildir**: (gün, normalize sorgu)
başına kimliksiz sayaçtır, rızaya bağlı değildir, bu dosyaya olay olarak
eklenmez.

Domain tabloları olayların kaynağıdır, olay tablosu onları kopyalamaz:

- `click`: mağaza çıkışı (attribution).
- `saved_item`: favori durumu.
- `ai_search_charge`: fotoğraf ve link araması.
- `product_view`: kullanıcıya gösterilen gezinme geçmişi; kendi rızası
  `browsing_history`'dir.

`session_started` ayrı bir olay değildir: oturum yalnızca girişte açılır,
yani `login_completed` ile aynı şeydir.

## Arama

| Olay | Alanlar | Not |
| --- | --- | --- |
| `search_submitted` | `mode` (bugün yalnızca `text`), `query_norm` (en fazla 200 karakter), `result_count` | Yeni bir aramanın ilk sayfası; rızalı. Fotoğraf/link araması `ai_search_charge` hizmet kaydıdır, analitik olayı yazılmaz |
| `search_resolved` | `parser_tier`, `cache_hit`, `intent` | Maliyet analizi |
| `search_results_shown` | `result_count`, `tab` | Boş sonuç da sayılır |
| `clarification_shown` | `candidate_count` | Netleştirme çubuğu |
| `clarification_selected` | `category_path` | Tahminimiz yanlıştı demek |
| `tab_switched` | `from`, `to` | Sekme tanımları doğru mu |

`clarification_selected` oranı önemli: yüksekse ilk tahmin motoru zayıf demektir.

## Ürün ve çıkış

| Olay | Alanlar |
| --- | --- |
| `product_viewed` | `product_id` (rızalı; `source` bugün yazılmaz) |
| `alternatives_shown` | `product_id`, `count` |
| `alternative_clicked` | `from_product_id`, `to_product_id`, `list_position`, `matched_kind` (tanımlı, yazılmaz) |
| `merchant_exit` | `click_id`, `offer_id` (rızalı; fiyat ve mağaza `click`/`offer`'dan okunur, kopyalanmaz) |
| `price_history_expanded` | `product_id` |

`merchant_exit` `click` tablosuyla aynı olayı temsil eder; analitik kopyası
raporlama içindir, attribution kaynağı her zaman veritabanıdır.

İkisinin sınıfı farklıdır (0049 §5):

- `click` her çıkışta yazılır (CLAUDE.md kural 8).
- `merchant_exit` yalnızca analitik rızasıyla yazılır.
- `click` satırları davranışsal analitiğe, kullanıcı sayaçlarına ya da
  kullanıcı başına ilgi/segment üretimine **kaynak olarak kullanılmaz**.
  Kullanıcı davranışı ölçülecekse rızalı `merchant_exit` kullanılır.

`alternative_clicked` içindeki `list_position`, tıklanan alternatifin listede
kaçıncı sırada gösterildiğini; `matched_kind`, o sonucu üreten
`similarity_edge.kind` değerini taşır (`same`, `visual`, `semantic`,
`substitute`). Bu iki alan, hangi benzerlik türünün gerçekte tıklamayı ve
dönüşümü sürüklediğini ölçmek içindir; sıralama ağırlıkları buna göre
güncellenir (`docs/search.md`).

## Hesap

| Olay | Alanlar |
| --- | --- |
| `login_modal_shown` | `trigger` (search_limit/save/alert/ai_search) |
| `login_requested` | — |
| `login_completed` | `is_new_user`, `provider` |
| `logout_completed` | — |
| `session_revoked` | — |
| `consent_changed` | `kind`, `granted`, `source`, `text_version` |

`source` ve `text_version` 0037 ile eklendi; ondan önceki satırlarda boştur
("sürümsüz kayıt") ve bu satırlar geçerli kararlardır.

Bu dördü hizmet/güvenlik sınıfındadır ve analitik kanalına gönderilmez. Her
biri bir tabloya karşılık gelir:

- `login_completed` → `auth_event`, `kind` değeri `sign_up` ya da
  `sign_in`.
- `logout_completed` → `auth_event`, `kind` değeri `sign_out`.
- `session_revoked` → `auth_event`, `kind` değeri `session_revoked` (yönetim
  oturum politikası ya da tüm cihazlardan çıkış).
- `consent_changed` → `user_consent` (geçmiş tablosu: kod yalnızca INSERT yapar).

`auth_event` cihaz/tarayıcı/ülke bilgisini yalnızca kaba sınıf olarak
taşır (0049 §9). `login_modal_shown` ve `login_requested` analitik
sınıfındadır ve bugün yazılmaz.

## Kaydetme ve alarm

| Olay | Alanlar |
| --- | --- |
| `item_saved` | `product_id`, `source_creator_id` (tanımlı, yazılmaz; kaynak `saved_item`) |
| `item_unsaved` | `product_id` (tanımlı, yazılmaz) |
| `alert_created` | `kind`, `product_id` |
| `alert_triggered` | `kind`, `product_id` |
| `alert_email_opened` | `kind` |

## Creator

| Olay | Alanlar |
| --- | --- |
| `creator_profile_viewed` | `creator_id`, `referrer` |
| `collection_viewed` | `collection_id` |
| `creator_followed` | `creator_id` |
| `collection_item_added` | `creator_id`, `product_id` |

## Keşfet ve trend

| Olay | Alanlar |
| --- | --- |
| `discovery_viewed` | `slot_date` |
| `discovery_item_clicked` | `product_id`, `source` (curated/organic) |
| `trend_viewed` | `slug` |

`discovery_item_clicked` içindeki `source` alanı, seçilmiş havuzun gerçek
keşiflere göre ne kadar iyi çalıştığını gösterir.

## api_usage ile ilişki

Analitik olayları ürün davranışını ölçer; `api_usage` maliyeti ölçer. İkisi
`session_id` üzerinden birleştirilerek oturum başına gelir ve maliyet
hesaplanır. Bu birleştirme birim ekonomisi raporunun tamamıdır.

## Türetilmiş niyet sinyalleri

Bu bölümdeki sinyaller **olay değildir**; hiçbiri doğrudan gönderilmez. Var
olan olaylardan (`product_viewed`, `search_submitted`, filtre kullanımı)
periyodik bir işle türetilir — `similarity_edge.kind = 'substitute'`
kenarının tıklama ve dönüşüm verisinden öğrenilmesiyle aynı ilkeyi izler
(`docs/architecture.md`, "4. Benzerlik").

Örnekler:

- Aynı ürüne tekrarlanan `product_viewed`
- Aynı kategoriye kısa aralıklarla geri dönüş
- Fiyat filtresi kullanım sıklığı

Bu sinyaller yalnızca toplu/istatistiksel biçimde sıralama ve öneri
ağırlıklarını beslemek için kullanılır. **`app_user` üzerinde kalıcı bir alan
ya da ayrı bir "kullanıcı segmenti" kolonu olarak yazılmaz** — sinyal her
koşuda yeniden hesaplanır, saklanan bir kimlik veya etiket değildir.
Kişiselleştirme rızası (`user_consent.kind = 'personalization'`, bkz.
`docs/kvkk.md`) reddedilmişse bu türetme o kullanıcı için hiç çalışmaz.

## Gönderilmeyecekler

- E-posta adresi, ad, IP — analitik yükünde kişisel veri taşınmaz
- Ham sorgu metni değil, normalize edilmiş hali (`query_norm`, en fazla 200
  karakter)
- Rıza verilmemişse kişiselleştirmeye dair hiçbir olay
- Analitik rızası yoksa ya da bilinmiyorsa hiçbir analitik olayı
- Ham user agent, ülke ya da konum: analitik olaylarında yok. Kaba
  cihaz/ülke yalnızca güvenlik bağlamında `auth_event`'te tutulur.
- Token, çerez değeri, istek başlığı ya da gövdesi: hiçbir olayda yok.
  Olay kolonları tiplidir; serbest `metadata` alanı yoktur.
