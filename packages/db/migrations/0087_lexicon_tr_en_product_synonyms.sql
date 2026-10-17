-- kind: data
-- 0087 — Turkce sorgu <-> Ingilizce urun basligi esanlamlilari (karar 0131)
--
-- AliExpress kaynak ilanlari (karar 0121) Ingilizce anahtar kelime basliklaridir:
-- "Wireless Bluetooth Speaker", "Shockproof Case for iPhone 16 Pro". Sohbet ve
-- `/ara` kullanicisi Turkce yazar: "bluetooth hoparlor", "iphone 16 kilifi". Metin
-- kapisi token duzeyindedir (karar 0029); esanlam olmadan Turkce sorgu Ingilizce
-- basliga hic eslesmez. Ayni `normalized` degerini paylasan yuzeyler bir slotun
-- alternatifleridir; filtre uretmez, katalog verisine dokunmaz.
--
-- Ekli bicimler ("kılıfı", "kulaklığı", "hoparlörü") ayrica yazilir: slot eslesmesi
-- katlanmis token ile birebirdir. Mevcut gruplar (0020: kulaklik, kablosuz ...)
-- genisletilir. Yalnizca ekleme; ON CONFLICT DO NOTHING elle eklenmis satiri ezmez.

INSERT INTO lexicon (kind, surface, normalized) VALUES
    -- kulaklik (0020 grubu)
    ('synonym', 'kulaklığı', 'kulaklik'),
    ('synonym', 'earphones', 'kulaklik'),
    ('synonym', 'headphones', 'kulaklik'),
    ('synonym', 'earbuds', 'kulaklik'),
    ('synonym', 'earbud', 'kulaklik'),
    -- kilif
    ('synonym', 'kılıf', 'kilif'),
    ('synonym', 'kılıfı', 'kilif'),
    ('synonym', 'case', 'kilif'),
    ('synonym', 'cover', 'kilif'),
    -- hoparlor
    ('synonym', 'hoparlör', 'hoparlor'),
    ('synonym', 'hoparlörü', 'hoparlor'),
    ('synonym', 'speaker', 'hoparlor'),
    ('synonym', 'speakers', 'hoparlor'),
    -- oyuncu
    ('synonym', 'oyuncu', 'oyuncu'),
    ('synonym', 'gaming', 'oyuncu'),
    ('synonym', 'gamer', 'oyuncu'),
    -- akilli saat
    ('synonym', 'akıllı saat', 'akilli-saat'),
    ('synonym', 'akıllı saati', 'akilli-saat'),
    ('synonym', 'smart watch', 'akilli-saat'),
    ('synonym', 'smartwatch', 'akilli-saat'),
    -- sarj
    ('synonym', 'şarj aleti', 'sarj-aleti'),
    ('synonym', 'şarj cihazı', 'sarj-aleti'),
    ('synonym', 'charger', 'sarj-aleti'),
    ('synonym', 'şarj kablosu', 'sarj-kablosu'),
    ('synonym', 'charging cable', 'sarj-kablosu'),
    ('synonym', 'powerbank', 'powerbank'),
    ('synonym', 'power bank', 'powerbank'),
    ('synonym', 'ekran koruyucu', 'ekran-koruyucu'),
    ('synonym', 'screen protector', 'ekran-koruyucu'),
    ('synonym', 'mikrofon', 'mikrofon'),
    ('synonym', 'microphone', 'mikrofon'),
    -- canta / giyim
    ('synonym', 'çanta', 'canta'),
    ('synonym', 'çantası', 'canta'),
    ('synonym', 'bag', 'canta'),
    ('synonym', 'handbag', 'canta'),
    ('synonym', 'sırt çantası', 'sirt-cantasi'),
    ('synonym', 'backpack', 'sirt-cantasi'),
    ('synonym', 'ayakkabı', 'ayakkabi'),
    ('synonym', 'ayakkabısı', 'ayakkabi'),
    ('synonym', 'shoes', 'ayakkabi'),
    ('synonym', 'elbise', 'elbise'),
    ('synonym', 'dress', 'elbise'),
    ('synonym', 'kolye', 'kolye'),
    ('synonym', 'necklace', 'kolye'),
    ('synonym', 'küpe', 'kupe'),
    ('synonym', 'earrings', 'kupe'),
    ('synonym', 'bileklik', 'bileklik'),
    ('synonym', 'bracelet', 'bileklik'),
    -- ev / spor / oyuncak
    ('synonym', 'termos', 'termos'),
    ('synonym', 'thermos', 'termos'),
    ('synonym', 'matara', 'matara'),
    ('synonym', 'water bottle', 'matara'),
    ('synonym', 'yoga matı', 'yoga-mati'),
    ('synonym', 'yoga mat', 'yoga-mati'),
    ('synonym', 'oyuncak', 'oyuncak'),
    ('synonym', 'toy', 'oyuncak'),
    ('synonym', 'peruk', 'peruk'),
    ('synonym', 'wig', 'peruk')
ON CONFLICT (kind, surface) DO NOTHING;
