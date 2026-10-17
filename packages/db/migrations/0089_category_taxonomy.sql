-- kind: data
-- 0089 — merkezi kategori agaci: magazadan bagimsiz, hiyerarsik, Turkce (karar 0133)
--
-- Mevcut agac (0016'nin 9 ana kategorisi + tohum alt kategorileri) GENISLETILIR; ikinci bir
-- agac kurulmaz. Anahtar `path`tir: ayni yol zaten varsa satir atlanir (tohumun ya da elle
-- eklenmis dugumun adi/slug'i korunur), yoksa eklenir. Ebeveyn yoldan bulunur; ebeveyni
-- olmayan dugum atlanir ve NOTICE ile raporlanir (dagitim dusmez).
--
-- Slug = yolun '-' ile birlesimi (`elektronik/telefon` -> `elektronik-telefon`, tohumla ayni
-- bicim). Slug baska bir yolda kullaniliyorsa sonuna `-k` eklenir.
--
-- `is_discoverable = FALSE`: ic giyim, mayo, saglik, cinsel saglik, petshop/supermarket alti
-- (kesfet akisina girmez; arama ve siniflandirma etkilenmez).
--
-- Kaynak eslemesi (AliExpress/Hepsiburada/Trendyol kategori adi -> bu yollar) ve arama
-- yuzeyleri `services/ingest/classify/taxonomy.py` icindedir; ordaki her yol burada olmalidir
-- (birim testi bu dosyayi okur).

DO $$
DECLARE
    node RECORD;
    parent BIGINT;
    candidate TEXT;
    skipped INTEGER := 0;
BEGIN
    FOR node IN
        SELECT t.path, t.name, t.discoverable
          FROM (VALUES
            -- ana kategoriler (0016'da var; burada yalniz eksikse eklenir)
            ('elektronik', 'Elektronik', TRUE),
            ('ev-yasam', 'Ev / Yasam', TRUE),
            ('moda', 'Moda', TRUE),
            ('saglik-kozmetik', 'Saglik / Kozmetik', TRUE),
            ('anne-bebek', 'Anne / Bebek', TRUE),
            ('kitap-muzik-hobi', 'Kitap / Muzik / Hobi', TRUE),
            ('spor-outdoor', 'Spor / Outdoor', TRUE),
            ('oto-bahce', 'Oto / Bahce', TRUE),
            ('petshop', 'Petshop', FALSE),
            ('supermarket', 'Supermarket', FALSE),
            -- Elektronik
            ('elektronik/telefon', 'Telefon', TRUE),
            ('elektronik/telefon/cep-telefonu', 'Cep Telefonları', TRUE),
            ('elektronik/telefon/aksesuar', 'Telefon Aksesuarları', TRUE),
            ('elektronik/telefon/aksesuar/kilif', 'Telefon Kılıfları', TRUE),
            ('elektronik/telefon/aksesuar/ekran-koruyucu', 'Ekran Koruyucular', TRUE),
            ('elektronik/telefon/aksesuar/sarj-kablo', 'Şarj Cihazları ve Kablolar', TRUE),
            ('elektronik/telefon/aksesuar/powerbank', 'Powerbank', TRUE),
            ('elektronik/telefon/aksesuar/tutucu', 'Telefon Tutucular', TRUE),
            ('elektronik/ses', 'Ses Sistemleri', TRUE),
            ('elektronik/ses/kulaklik', 'Kulaklıklar', TRUE),
            ('elektronik/ses/kulaklik/kablosuz', 'Kablosuz Kulaklıklar', TRUE),
            ('elektronik/ses/kulaklik/oyuncu', 'Oyuncu Kulaklıkları', TRUE),
            ('elektronik/ses/kulaklik/kablolu', 'Kablolu Kulaklıklar', TRUE),
            ('elektronik/ses/hoparlor', 'Hoparlörler', TRUE),
            ('elektronik/ses/mikrofon', 'Mikrofonlar', TRUE),
            ('elektronik/bilgisayar', 'Bilgisayar', TRUE),
            ('elektronik/bilgisayar/dizustu', 'Dizüstü Bilgisayarlar', TRUE),
            ('elektronik/bilgisayar/tablet', 'Tabletler', TRUE),
            ('elektronik/bilgisayar/klavye-mouse', 'Klavye ve Mouse', TRUE),
            ('elektronik/bilgisayar/depolama', 'Depolama ve Bellek', TRUE),
            ('elektronik/bilgisayar/bilesen', 'Bilgisayar Bileşenleri', TRUE),
            ('elektronik/bilgisayar/ag', 'Ağ Ürünleri', TRUE),
            ('elektronik/bilgisayar/aksesuar', 'Bilgisayar Aksesuarları', TRUE),
            ('elektronik/giyilebilir', 'Giyilebilir Teknoloji', TRUE),
            ('elektronik/giyilebilir/akilli-saat', 'Akıllı Saatler', TRUE),
            ('elektronik/giyilebilir/akilli-bileklik', 'Akıllı Bileklikler', TRUE),
            ('elektronik/giyilebilir/kordon', 'Akıllı Saat Kordonları', TRUE),
            ('elektronik/kamera', 'Kamera ve Fotoğraf', TRUE),
            ('elektronik/kamera/aksiyon-kamerasi', 'Aksiyon Kameraları', TRUE),
            ('elektronik/kamera/guvenlik-kamerasi', 'Güvenlik Kameraları', TRUE),
            ('elektronik/kamera/aksesuar', 'Kamera Aksesuarları', TRUE),
            ('elektronik/kamera/drone', 'Drone', TRUE),
            ('elektronik/tv-goruntu', 'TV ve Görüntü', TRUE),
            ('elektronik/tv-goruntu/projeksiyon', 'Projeksiyon Cihazları', TRUE),
            ('elektronik/tv-goruntu/medya-oynatici', 'TV Box ve Medya Oynatıcılar', TRUE),
            ('elektronik/oyun', 'Oyun ve Konsol', TRUE),
            ('elektronik/oyun/konsol', 'Oyun Konsolları', TRUE),
            ('elektronik/oyun/aksesuar', 'Oyun Aksesuarları', TRUE),
            ('elektronik/bilesen', 'Elektronik Bileşenler ve Modüller', TRUE),
            ('elektronik/akilli-ev', 'Akıllı Ev', TRUE),
            -- Ev / Yasam
            ('ev-yasam/mutfak', 'Mutfak', TRUE),
            ('ev-yasam/mutfak/kahve-ekipmanlari', 'Kahve Ekipmanları', TRUE),
            ('ev-yasam/mutfak/pisirme-gerecleri', 'Pişirme Gereçleri', TRUE),
            ('ev-yasam/mutfak/mutfak-gerecleri', 'Mutfak Gereçleri', TRUE),
            ('ev-yasam/mutfak/saklama', 'Saklama Kapları', TRUE),
            ('ev-yasam/mutfak/sofra', 'Sofra ve Servis', TRUE),
            ('ev-yasam/mutfak/termos-matara', 'Termos ve Mataralar', TRUE),
            ('ev-yasam/ev-tekstili', 'Ev Tekstili', TRUE),
            ('ev-yasam/mobilya', 'Mobilya', TRUE),
            ('ev-yasam/dekorasyon', 'Dekorasyon', TRUE),
            ('ev-yasam/aydinlatma', 'Aydınlatma', TRUE),
            ('ev-yasam/banyo', 'Banyo', TRUE),
            ('ev-yasam/duzenleme-temizlik', 'Düzenleme ve Temizlik', TRUE),
            ('ev-yasam/ev-aletleri', 'Ev Aletleri', TRUE),
            ('ev-yasam/ev-aletleri/kucuk-ev-aletleri', 'Küçük Ev Aletleri', TRUE),
            ('ev-yasam/ev-aletleri/supurge', 'Süpürgeler', TRUE),
            ('ev-yasam/yapi-market', 'Yapı Market', TRUE),
            ('ev-yasam/yapi-market/el-aletleri', 'El Aletleri', TRUE),
            ('ev-yasam/yapi-market/elektrikli-aletler', 'Elektrikli Aletler', TRUE),
            ('ev-yasam/yapi-market/hirdavat', 'Hırdavat', TRUE),
            -- Moda
            ('moda/kadin-giyim', 'Kadın Giyim', TRUE),
            ('moda/kadin-giyim/elbise', 'Elbise', TRUE),
            ('moda/kadin-giyim/ust-giyim', 'Kadın Üst Giyim', TRUE),
            ('moda/kadin-giyim/alt-giyim', 'Kadın Alt Giyim', TRUE),
            ('moda/kadin-giyim/dis-giyim', 'Kadın Dış Giyim', TRUE),
            ('moda/kadin-giyim/ic-giyim', 'Kadın İç Giyim', FALSE),
            ('moda/kadin-giyim/mayo-bikini', 'Mayo ve Bikini', FALSE),
            ('moda/erkek-giyim', 'Erkek Giyim', TRUE),
            ('moda/erkek-giyim/ust-giyim', 'Erkek Üst Giyim', TRUE),
            ('moda/erkek-giyim/alt-giyim', 'Erkek Alt Giyim', TRUE),
            ('moda/erkek-giyim/dis-giyim', 'Erkek Dış Giyim', TRUE),
            ('moda/erkek-giyim/ic-giyim', 'Erkek İç Giyim', FALSE),
            ('moda/ayakkabi', 'Ayakkabı', TRUE),
            ('moda/ayakkabi/spor-ayakkabi', 'Spor Ayakkabı', TRUE),
            ('moda/ayakkabi/bot', 'Bot ve Çizme', TRUE),
            ('moda/ayakkabi/sandalet-terlik', 'Sandalet ve Terlik', TRUE),
            ('moda/ayakkabi/topuklu', 'Topuklu Ayakkabı', TRUE),
            ('moda/ayakkabi/gunluk', 'Günlük Ayakkabı', TRUE),
            ('moda/canta', 'Çanta', TRUE),
            ('moda/canta/omuz-cantasi', 'Omuz Çantaları', TRUE),
            ('moda/canta/capraz-canta', 'Çapraz Askılı Çantalar', TRUE),
            ('moda/canta/el-cantasi', 'El Çantaları', TRUE),
            ('moda/canta/sirt-cantasi', 'Sırt Çantaları', TRUE),
            ('moda/canta/cuzdan', 'Cüzdanlar', TRUE),
            ('moda/canta/bel-cantasi', 'Bel Çantaları', TRUE),
            ('moda/canta/valiz', 'Valiz ve Seyahat', TRUE),
            ('moda/aksesuar', 'Aksesuar', TRUE),
            ('moda/aksesuar/taki', 'Takı', TRUE),
            ('moda/aksesuar/saat', 'Saat', TRUE),
            ('moda/aksesuar/gunes-gozlugu', 'Güneş Gözlüğü', TRUE),
            ('moda/aksesuar/sapka-bere', 'Şapka ve Bere', TRUE),
            ('moda/aksesuar/kemer', 'Kemer', TRUE),
            ('moda/aksesuar/sac-aksesuari', 'Saç Aksesuarları', TRUE),
            ('moda/aksesuar/atki-sal', 'Atkı ve Şal', TRUE),
            -- Saglik / Kozmetik
            ('saglik-kozmetik/kozmetik', 'Kozmetik', TRUE),
            ('saglik-kozmetik/kozmetik/makyaj', 'Makyaj', TRUE),
            ('saglik-kozmetik/kozmetik/cilt-bakimi', 'Cilt Bakımı', TRUE),
            ('saglik-kozmetik/kozmetik/sac-bakimi', 'Saç Bakımı', TRUE),
            ('saglik-kozmetik/kozmetik/parfum', 'Parfüm', TRUE),
            ('saglik-kozmetik/kozmetik/tirnak', 'Tırnak Bakımı', TRUE),
            ('saglik-kozmetik/kisisel-bakim', 'Kişisel Bakım', TRUE),
            ('saglik-kozmetik/kisisel-bakim/tiras-epilasyon', 'Tıraş ve Epilasyon', TRUE),
            ('saglik-kozmetik/kisisel-bakim/agiz-dis', 'Ağız ve Diş Bakımı', TRUE),
            ('saglik-kozmetik/peruk', 'Peruk ve Saç Ekleme', TRUE),
            ('saglik-kozmetik/saglik', 'Sağlık', FALSE),
            ('saglik-kozmetik/cinsel-saglik', 'Cinsel Sağlık', FALSE),
            -- Anne / Bebek
            ('anne-bebek/oyuncak', 'Oyuncak', TRUE),
            ('anne-bebek/oyuncak/egitici', 'Eğitici Oyuncaklar', TRUE),
            ('anne-bebek/oyuncak/figur-model', 'Figür ve Model', TRUE),
            ('anne-bebek/oyuncak/uzaktan-kumandali', 'Uzaktan Kumandalı Oyuncaklar', TRUE),
            ('anne-bebek/oyuncak/pelus', 'Peluş Oyuncaklar', TRUE),
            ('anne-bebek/bebek-bakim', 'Bebek Bakım', TRUE),
            ('anne-bebek/cocuk-giyim', 'Bebek ve Çocuk Giyim', TRUE),
            -- Kitap / Muzik / Hobi
            ('kitap-muzik-hobi/kitap', 'Kitap', TRUE),
            ('kitap-muzik-hobi/hobi-sanat', 'Hobi ve Sanat', TRUE),
            ('kitap-muzik-hobi/dikis-orgu', 'Dikiş ve Örgü', TRUE),
            ('kitap-muzik-hobi/muzik-aletleri', 'Müzik Aletleri', TRUE),
            ('kitap-muzik-hobi/kirtasiye-ofis', 'Kırtasiye ve Ofis', TRUE),
            ('kitap-muzik-hobi/parti', 'Parti ve Kutlama', TRUE),
            -- Spor / Outdoor
            ('spor-outdoor/fitness', 'Fitness', TRUE),
            ('spor-outdoor/kamp-outdoor', 'Kamp ve Outdoor', TRUE),
            ('spor-outdoor/bisiklet', 'Bisiklet', TRUE),
            ('spor-outdoor/balikcilik', 'Balıkçılık', TRUE),
            ('spor-outdoor/spor-giyim', 'Spor Giyim', TRUE),
            ('spor-outdoor/su-sporlari', 'Su Sporları', TRUE),
            -- Oto / Bahce
            ('oto-bahce/oto-aksesuar', 'Oto Aksesuar', TRUE),
            ('oto-bahce/oto-elektronik', 'Oto Elektronik', TRUE),
            ('oto-bahce/oto-yedek-parca', 'Oto Yedek Parça', TRUE),
            ('oto-bahce/motosiklet', 'Motosiklet', TRUE),
            ('oto-bahce/bahce', 'Bahçe', TRUE),
            -- Petshop (ana kategori kesfete kapali; alt dugumler de)
            ('petshop/kedi', 'Kedi', FALSE),
            ('petshop/kopek', 'Köpek', FALSE),
            ('petshop/akvaryum', 'Akvaryum', FALSE)
          ) AS t(path, name, discoverable)
         ORDER BY array_length(string_to_array(t.path, '/'), 1), t.path
    LOOP
        IF EXISTS (SELECT 1 FROM category WHERE path = node.path) THEN
            CONTINUE;
        END IF;
        parent := NULL;
        IF position('/' IN node.path) > 0 THEN
            SELECT id INTO parent FROM category
             WHERE path = regexp_replace(node.path, '/[^/]+$', '')
             ORDER BY id LIMIT 1;
            IF parent IS NULL THEN
                skipped := skipped + 1;
                RAISE NOTICE '0089: ebeveyni olmayan dugum atlandi: %', node.path;
                CONTINUE;
            END IF;
        END IF;
        candidate := replace(node.path, '/', '-');
        IF EXISTS (SELECT 1 FROM category WHERE slug = candidate) THEN
            candidate := candidate || '-k';
        END IF;
        INSERT INTO category (slug, name, parent_id, path, is_discoverable)
        VALUES (candidate, node.name, parent, node.path, node.discoverable)
        ON CONFLICT (slug) DO NOTHING;
    END LOOP;
    IF skipped > 0 THEN
        RAISE NOTICE '0089: % dugum atlandi', skipped;
    END IF;
END $$;
