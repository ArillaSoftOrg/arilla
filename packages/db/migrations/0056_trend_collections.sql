-- 0056 — trend / trend_product: editoryal urun kesfi koleksiyonlari (docs/decisions/0077)
--
-- `/trendler` ve `/trendler/<slug>` icin. Bir trend blog degil, ELLE adlandirilmis
-- ve TOPLU ISLE urunle doldurulan bir koleksiyondur: kisa baslik + tek cumle
-- aciklama + urun izgarasi. Istek yolu yalnizca okur (kural 2): urun secimi
-- `services/ingest/curate` is'inde yapilir ve `trend_product`a yazilir; sayfa
-- hicbir sey hesaplamaz, model cagirmaz.
--
-- `trend_snapshot` (0009: donemlik, algoritmik, sponsorlu liste) AYRI ve
-- dokunulmamis kalir. Orada urunler `product_ids BIGINT[]` dizisidir ve
-- ID butunlugunu motor saglamaz; burada `trend_product` FK'lidir.
--
-- Isimlendirme: depo tekil tablo adi kullanir (product, offer, collection);
-- bu yuzden `trend` / `trend_product` (talepteki `trends` / `trend_products`).
--
-- Tohum: 50 trendin KIMLIGI (baslik, aciklama, tur, sira) burada, cunku
-- ortamdan bagimsizdir ve migration ile birlikte gider. Urun BAGLARI burada
-- YOK — katalog ortama ozeldir; `curate` is'i doldurur. Urunu olmayan (veya
-- `MIN_PUBLIC_TREND_PRODUCTS`tan az olan) trend arayuzde gorunmez, detay
-- adresi 404 doner. Bu yuzden hepsi 'published' tohumlanir.
--
-- Yeni tablolar + tohum satirlari; mevcut hicbir tabloya dokunmaz, geriye
-- uyumludur. Geri alma: DROP TABLE trend_product; DROP TABLE trend;

CREATE TABLE IF NOT EXISTS trend (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug            TEXT        NOT NULL,
    title           TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    description     TEXT        NOT NULL CHECK (char_length(description) BETWEEN 1 AND 280),
    -- Konu grubu (arayuz sekmesi). 'genel' = kampanya/ortak temalar.
    category        TEXT        NOT NULL
                    CHECK (category IN ('moda', 'guzellik', 'ev-yasam', 'ogrenci', 'genel')),
    -- Ayri editoryal gorsel gelene kadar NULL; okuma sirasinda temsilci urun
    -- gorseline, o da yoksa yer tutucuya dusulur. Yalnizca https.
    hero_image_url  TEXT        CHECK (hero_image_url IS NULL
                                       OR (hero_image_url ~ '^https://'
                                           AND char_length(hero_image_url) <= 2048)),
    status          TEXT        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'published', 'archived')),
    featured        BOOLEAN     NOT NULL DEFAULT FALSE,
    trend_type      TEXT        NOT NULL DEFAULT 'evergreen'
                    CHECK (trend_type IN ('evergreen', 'seasonal', 'campaign')),
    sort_order      INTEGER     NOT NULL DEFAULT 0,
    -- Yayin penceresi. NULL = sinirsiz. Pencere disindaki trend "Su An Trend"
    -- bolumunde cikmaz; /trendler'de ve adresinde erisilebilir kalir.
    active_from     TIMESTAMPTZ,
    active_until    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT trend_slug_uniq UNIQUE (slug),
    CONSTRAINT trend_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                                       AND char_length(slug) <= 80),
    CONSTRAINT trend_active_window CHECK (active_from IS NULL OR active_until IS NULL
                                          OR active_from < active_until)
);

CREATE INDEX IF NOT EXISTS trend_listing_idx
    ON trend (sort_order, id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS trend_product (
    trend_id    BIGINT      NOT NULL REFERENCES trend(id) ON DELETE CASCADE,
    product_id  BIGINT      NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    -- Trend icindeki gosterim sirasi (0 = en iyi eslesme).
    sort_order  INTEGER     NOT NULL CHECK (sort_order >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (trend_id, product_id),
    -- Ayni trendde iki urun ayni siraya oturmaz. ERTELENMIS: curate is'i
    -- siralamayi tek islemde yeniden yazabilsin; kontrol COMMIT'te yapilir.
    CONSTRAINT trend_product_order_uniq UNIQUE (trend_id, sort_order)
        DEFERRABLE INITIALLY DEFERRED
);

-- Ters yon: "bu urun hangi trendlerde?" ve urun silinirken FK taramasi.
CREATE INDEX IF NOT EXISTS trend_product_product_idx ON trend_product (product_id);

COMMENT ON TABLE trend IS
    'Editoryal urun kesfi koleksiyonu (/trendler). Blog degil. Karar 0077.';
COMMENT ON TABLE trend_product IS
    'Trend-urun baglari; curate toplu isi yazar, istek yolu yalnizca okur. Karar 0077.';

INSERT INTO trend (slug, title, description, category, trend_type, featured, sort_order,
                   active_from, active_until, status)
SELECT v.slug, v.title, v.description, v.category, v.trend_type, v.featured, v.sort_order,
       v.active_from, v.active_until, 'published'
  FROM (VALUES
    ('kuru-ciltlere-son', 'Kuru Ciltlere Son', 'Nemi içeride tutan kremler, serumlar ve bariyer bakımları bir arada.', 'guzellik', 'evergreen', TRUE, 10, NULL, NULL),
    ('okula-donus-listesi', 'Okula Dönüş Listesi', 'Yeni dönemin listesinde yer alabilecek çanta ve gündelik parçalar.', 'ogrenci', 'seasonal', FALSE, 20, '2026-08-15'::timestamptz, '2026-10-31'::timestamptz),
    ('universiteye-baslayanlar-icin', 'Üniversiteye Başlayanlar İçin', 'Yeni bir şehre ve yeni bir düzene geçerken işe yarayacak seçimler.', 'ogrenci', 'seasonal', FALSE, 30, '2026-08-15'::timestamptz, '2026-10-31'::timestamptz),
    ('kyk-odasinin-olmazsa-olmazlari', 'KYK Odasının Olmazsa Olmazları', 'Küçük bir odayı düzenli ve rahat tutan pratik parçalar.', 'ogrenci', 'seasonal', FALSE, 40, '2026-08-15'::timestamptz, '2026-10-31'::timestamptz),
    ('kampus-kombinleri', 'Kampüs Kombinleri', 'Sabah derslerinden akşam buluşmalarına rahat giyilen parçalar.', 'ogrenci', 'evergreen', FALSE, 50, NULL, NULL),
    ('sonbahara-hazir-misin', 'Sonbahara Hazır mısın?', 'Mevsim değişirken gardıropta yer açılması gereken parçalar.', 'moda', 'seasonal', TRUE, 60, '2026-09-01'::timestamptz, '2026-11-30'::timestamptz),
    ('yagmurlu-gunler-icin', 'Yağmurlu Günler İçin', 'Islanmadan dışarı çıkmak için ceket, bot ve yağmurluklar.', 'moda', 'seasonal', FALSE, 70, '2026-09-15'::timestamptz, '2026-12-15'::timestamptz),
    ('kazak-mevsimi-basladi', 'Kazak Mevsimi Başladı', 'Kazak, triko ve hırkalar; mevsimin ilk soğuğuna karşı.', 'moda', 'seasonal', FALSE, 80, '2026-09-15'::timestamptz, '2026-12-15'::timestamptz),
    ('havalar-sogurken', 'Havalar Soğurken', 'Üst üste giyilebilen, sıcak tutan parçalar.', 'moda', 'seasonal', FALSE, 90, '2026-09-15'::timestamptz, '2026-12-15'::timestamptz),
    ('kis-gelmeden-al', 'Kış Gelmeden Al', 'Mont, kaban ve aksesuarlara kış bastırmadan göz atmak için.', 'moda', 'seasonal', TRUE, 100, '2026-10-01'::timestamptz, '2026-12-15'::timestamptz),
    ('bu-sonbaharin-renkleri', 'Bu Sonbaharın Renkleri', 'Bordo, kahve, haki ve camel tonlarında seçilmiş parçalar.', 'moda', 'seasonal', FALSE, 110, '2026-09-01'::timestamptz, '2026-11-30'::timestamptz),
    ('kahve-tonlari', 'Kahve Tonları', 'Açık süt kahvesinden koyu çikolataya uzanan kahverengi parçalar.', 'moda', 'seasonal', FALSE, 120, '2026-09-01'::timestamptz, '2026-11-30'::timestamptz),
    ('bordo-geri-dondu', 'Bordo Geri Döndü', 'Çantadan ayakkabıya, koyu kırmızının öne çıktığı parçalar.', 'moda', 'seasonal', FALSE, 130, '2026-09-01'::timestamptz, '2026-12-15'::timestamptz),
    ('kot-her-yerde', 'Kot Her Yerde', 'Pantolon, ceket ve etekte denimin farklı kalıpları.', 'moda', 'evergreen', FALSE, 140, NULL, NULL),
    ('babetler-geri-dondu', 'Babetler Geri Döndü', 'Düz tabanlı, rahat ve her kombine uyan babetler.', 'moda', 'evergreen', FALSE, 150, NULL, NULL),
    ('bol-paca-sezonu', 'Bol Paça Sezonu', 'Geniş kesim pantolonlar ve paçası rahat kalıplar.', 'moda', 'evergreen', FALSE, 160, NULL, NULL),
    ('bir-dolap-onlarca-kombin', 'Bir Dolap, Onlarca Kombin', 'Birbiriyle kolay eşleşen temel parçalar.', 'moda', 'evergreen', FALSE, 170, NULL, NULL),
    ('az-parcayla-cok-kombin', 'Az Parçayla Çok Kombin', 'Birkaç parçayla haftayı çıkarmaya yetecek seçimler.', 'moda', 'evergreen', FALSE, 180, NULL, NULL),
    ('her-gun-giyilecekler', 'Her Gün Giyilecekler', 'Sık sık elin gidecek sade ve rahat parçalar.', 'moda', 'evergreen', FALSE, 190, NULL, NULL),
    ('dolabin-kurtaricilari', 'Dolabın Kurtarıcıları', 'Ne giyeceğini bilemediğin sabahlarda işe yarayanlar.', 'moda', 'evergreen', FALSE, 200, NULL, NULL),
    ('ise-donus-kombinleri', 'İşe Dönüş Kombinleri', 'Ofis düzenine geri dönerken şık ve rahat kalmanı sağlayacak parçalar.', 'moda', 'evergreen', FALSE, 210, NULL, NULL),
    ('ofisten-aksam-yemegine', 'Ofisten Akşam Yemeğine', 'Gün boyu giyilip akşama da uyan parçalar.', 'moda', 'evergreen', FALSE, 220, NULL, NULL),
    ('dugun-sezonu', 'Düğün Sezonu', 'Davetlere hazırlanırken bakılacak elbise, ayakkabı ve çantalar.', 'moda', 'seasonal', FALSE, 230, '2027-04-15'::timestamptz, '2027-09-30'::timestamptz),
    ('nisan-ve-davet-elbiseleri', 'Nişan ve Davet Elbiseleri', 'Özel davetler için elbise seçenekleri.', 'moda', 'evergreen', FALSE, 240, NULL, NULL),
    ('mezuniyet-icin-ne-giyilir', 'Mezuniyet İçin Ne Giyilir?', 'Mezuniyet gününe uygun elbise, ayakkabı ve aksesuarlar.', 'moda', 'seasonal', FALSE, 250, '2027-05-01'::timestamptz, '2027-07-15'::timestamptz),
    ('bayramlik-bakmaya-baslayanlara', 'Bayramlık Bakmaya Başlayanlara', 'Bayrama acele etmeden hazırlanmak isteyenler için şık parçalar.', 'moda', 'seasonal', FALSE, 260, '2027-02-01'::timestamptz, '2027-03-20'::timestamptz),
    ('tatile-cikmadan-once', 'Tatile Çıkmadan Önce', 'Valizde yer açılacak hafif ve pratik parçalar.', 'moda', 'seasonal', FALSE, 270, '2027-05-01'::timestamptz, '2027-08-31'::timestamptz),
    ('ege-yazi', 'Ege Yazı', 'Sıcak günler için hafif kumaşlı, rahat parçalar.', 'moda', 'seasonal', FALSE, 280, '2027-05-01'::timestamptz, '2027-09-15'::timestamptz),
    ('sahile-giderken', 'Sahile Giderken', 'Denize ve sahile giderken çantaya atılacak parçalar.', 'moda', 'seasonal', FALSE, 290, '2027-05-15'::timestamptz, '2027-09-15'::timestamptz),
    ('hafta-sonu-kacamagi', 'Hafta Sonu Kaçamağı', 'Küçük bir çantaya sığan, iki günlük yola uygun parçalar.', 'moda', 'evergreen', FALSE, 300, NULL, NULL),
    ('cam-gibi-bir-cilt', 'Cam Gibi Bir Cilt', 'Nem ve ışıltıya odaklanan bakım ürünleri.', 'guzellik', 'evergreen', TRUE, 310, NULL, NULL),
    ('cildi-isil-isil-yapanlar', 'Cildi Işıl Işıl Yapanlar', 'Cilde canlı bir görünüm kazandırmak için aydınlatıcı bakımlar.', 'guzellik', 'evergreen', FALSE, 320, NULL, NULL),
    ('sivilceye-karsi-favoriler', 'Sivilceye Karşı Favoriler', 'Akneye eğilimli ciltler için temizleyici ve bakım ürünleri.', 'guzellik', 'evergreen', FALSE, 330, NULL, NULL),
    ('gozenek-gorunumune-karsi', 'Gözenek Görünümüne Karşı', 'Gözenekleri daha az belirgin gösteren tonik, serum ve maskeler.', 'guzellik', 'evergreen', FALSE, 340, NULL, NULL),
    ('gunes-lekelerine-karsi', 'Güneş Lekelerine Karşı', 'Leke bakımı ile güneş korumasını bir arada düşünenler için.', 'guzellik', 'evergreen', TRUE, 350, NULL, NULL),
    ('makyajsiz-guzel-gorun', 'Makyajsız Güzel Görün', 'Cilde doğal bir görünüm veren hafif ürünler.', 'guzellik', 'evergreen', FALSE, 360, NULL, NULL),
    ('5-dakikada-hazir', '5 Dakikada Hazır', 'Sabahın acelesinde işe yarayan hızlı makyaj ve bakım adımları.', 'guzellik', 'evergreen', FALSE, 370, NULL, NULL),
    ('cantadan-eksik-olmayanlar', 'Çantadan Eksik Olmayanlar', 'Gün içinde yanında taşımak isteyeceğin küçük bakım ürünleri.', 'guzellik', 'evergreen', FALSE, 380, NULL, NULL),
    ('uygun-fiyatli-guzellik-favorileri', 'Uygun Fiyatlı Güzellik Favorileri', 'Bütçeyi zorlamayan bakım ve makyaj ürünleri.', 'guzellik', 'evergreen', FALSE, 390, NULL, NULL),
    ('pahali-gorunen-uygun-fiyatlilar', 'Pahalı Görünen Uygun Fiyatlılar', 'Fiyatı mütevazı ama görünüşüyle öne çıkan ürünler.', 'guzellik', 'evergreen', FALSE, 400, NULL, NULL),
    ('evi-daha-pahali-gosteren-seyler', 'Evi Daha Pahalı Gösteren Şeyler', 'Odanın havasını değiştiren dokulu ve şık ev parçaları.', 'ev-yasam', 'evergreen', TRUE, 410, NULL, NULL),
    ('kucuk-eve-buyuk-fikirler', 'Küçük Eve Büyük Fikirler', 'Az yer kaplayan ve düzen sağlayan çözümler.', 'ev-yasam', 'evergreen', FALSE, 420, NULL, NULL),
    ('ogrenci-evi-kurtaricilari', 'Öğrenci Evi Kurtarıcıları', 'Paylaşılan evlerde işleri kolaylaştıran sade ürünler.', 'ogrenci', 'evergreen', FALSE, 430, NULL, NULL),
    ('yeni-eve-cikanlar-icin', 'Yeni Eve Çıkanlar İçin', 'İlk günden lazım olacak temel ev eşyaları.', 'ev-yasam', 'evergreen', FALSE, 440, NULL, NULL),
    ('kahve-kosesi-kuruyoruz', 'Kahve Köşesi Kuruyoruz', 'Evde kahve keyfi için makine, fincan ve ekipmanlar.', 'ev-yasam', 'evergreen', FALSE, 450, NULL, NULL),
    ('masa-basinda-daha-keyifli', 'Masa Başında Daha Keyifli', 'Uzun çalışma saatlerini rahatlatan masa ürünleri.', 'ev-yasam', 'evergreen', FALSE, 460, NULL, NULL),
    ('evde-sonbahar-havasi', 'Evde Sonbahar Havası', 'Sıcak tonlarda ev tekstili ve dekor parçaları.', 'ev-yasam', 'seasonal', FALSE, 470, '2026-09-01'::timestamptz, '2026-11-30'::timestamptz),
    ('11-11de-alinacaklar', '11.11''de Alınacaklar', '11.11 öncesinde fiyatını takip etmeye başlayabileceğin ürünler.', 'genel', 'campaign', FALSE, 480, '2026-10-20'::timestamptz, '2026-11-12'::timestamptz),
    ('kasim-indirimlerinde-beklenenler', 'Kasım İndirimlerinde Beklenenler', 'Kasım kampanyaları öncesinde göz önünde tutulacak ürünler.', 'genel', 'campaign', FALSE, 490, '2026-11-01'::timestamptz, '2026-11-30'::timestamptz),
    ('herkes-almadan-once', 'Herkes Almadan Önce', 'Kalabalıklaşmadan gözüne kestirebileceğin seçimler.', 'genel', 'evergreen', FALSE, 500, NULL, NULL)
  ) AS v(slug, title, description, category, trend_type, featured, sort_order,
         active_from, active_until)
ON CONFLICT (slug) DO NOTHING;
