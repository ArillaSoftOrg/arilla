# 0041 — Yönetim konsolu Faz 2–7: işletim, katalog, tanı ve kullanıcı ekranları

**Tarih:** 26 Eylül 2026
**Durum:** Kabul edildi

0039'un kabuğu, yetki haritası ve denetim kaydı üzerine kurulur; o kararın
hiçbir ilkesi değişmez.

## Karar

1. **Yeni ekranlar** (hepsi aynı kabuk ve `requireCapability` kapısı):
   `/yonetim/magazalar` (+ `[slug]`), `/yonetim/ingest`, `/yonetim/arama/link`,
   `/yonetim/eslestirme/gecmis`, `/yonetim/katalog/urunler` (+ `[id]`),
   `/yonetim/katalog/teklifler`, `/yonetim/arama/tani`, `/yonetim/arama/gorsel`,
   `/yonetim/islemler`, `/yonetim/kullanicilar` (+ `[publicId]`), `/yonetim/seo`.
2. **Tek yeni mutasyon: mağaza aç/kapat** (`merchant.is_active`). Yalnızca
   yönetici, gerekçe (5–500), mağaza kısa adını aynen yazma, **taze oturum**
   (12 saatten yeni; `session.created_at`) ve denetim kaydı. Açmak Shopify
   para birimi kapısını atlamaz. Feed adresi, `feed_config`, komisyon ve
   deeplink düzenlenmez.
3. **Yeni yetenek `operations.read`** (yalnızca yönetici): `/yonetim/islemler`
   maliyet ve KVKK temizlik durumunu gösterir.
4. **Eşleştirme (migration 0028):** `match_candidate.review_reason` (CHECK'li
   neden; `superseded` = onay kardeş adayları düşürdü), `explain` JSONB
   (resolver'ın skor açıklaması: yöntem, metin benzerliği, inceleme nedeni,
   otomatik kabul uygunluğu, o anki eşikler) ve `reviewed_by` FK. Eşikler ve
   karar mantığı değişmez. Klavye: A onayla, R reddet (1–5 neden, 0 nedensiz,
   Esc vazgeç), S atla.
5. **Tanı ekranları salt okunur ve sınırlıdır.** Her pahalı sorgu `READ ONLY`
   işlemde ve `statement_timeout` ile çalışır (`packages/core/src/admin/bounds.ts`).
   Arama tanısı gerçek boru hattını (`parseQueryText`, `planConversation`,
   `search()`) kullanır ama `resolveQuery`'yi çağırmaz: `query_resolution`'a,
   arama duvarı sayacına ve analitiğe yazmaz; yönetici başına dakikada 30.
6. **Gizli bilgi gösterilmez.** Adresler şema + ana makine + yol olarak,
   sorgu dizisi olmadan (`redact.ts`); Python hata metinlerindeki adresler de
   kırpılır. Link günlüğünde oturum, kullanıcı ve ham adres yok. Görsel
   yüklemede görsel, nesne anahtarı ve yükleyen yok.
7. **Kullanıcı bulma salt okunur ve denetlidir.** Yalnızca tam eşleşme
   (e-posta, E.164 telefon, public id), POST ile (değer adres satırına
   düşmez). Her arama (`users.lookup`) ve ayrıntı görüntüleme (`users.view`)
   denetime yazılır; aranan değer yazılmaz. İletişim bilgisi maskelidir.
8. **İşletim ekranı log tablosu değildir.** İş (cron) geçmişi tablosu yok;
   işlerin durumu ürettikleri verinin tazeliğinden okunur ve "son kanıt"
   diye etiketlenir. Yetim taraması `pnpm db:orphans` ile AYNI SQL'dir
   (`packages/db/src/health.ts`) ve yalnızca istenince çalışır.
   `price_point_default` doluluğu, uygulama rolünün partition'a erişimi
   olmadığı için ebeveyn tablo üzerinden kapsanmayan zaman aralığıyla ölçülür.
9. **SEO ekranı Search Console değildir.** Yalnızca katalog alanları, bizim
   sitemap uygunluk kuralımız (`sitemap-eligibility.ts`, aynı koşul) ve slug
   geçmişi.
10. **İndeks yalnızca kanıtla (migration 0029):** `link_resolution_request
    (created_at DESC, id DESC)`. 200.000 satırda liste sorgusu 24,6 ms tam
    taramadan 0,43 ms'ye indi. Başka indeks eklenmedi: diğer sorgular mevcut
    indeksleri kullanıyor (katlanmış başlık trigram, `offer (merchant_id, …)`,
    birincil anahtar imleçleri).

## Gerekçe

Katalog, veri toplama ve arama kalitesi sorunları bugün `psql` ile
ayıklanıyordu. Ekranlar mevcut veriyi güvenle okunur kılar; yazma yetkisi
tek, geri alınabilir ve denetlenen bir işlemle sınırlı kalır.

## Reddedilen / ertelenenler

"Şimdi çalıştır" ve yeniden deneme (kuyruk ve Python tüketicisi gerekir),
toplu onay, rol düzenleme, hesap silme, kimliğe bürünme, iş geçmişi tablosu,
genel log tablosu, arama günlüğü ve analitik panosu, Search Console
entegrasyonu, vitrin/trend editörü.
