-- 0020 — lexicon.kind'a 'synonym' eklendi + baslangic esanlam seti
-- (docs/decisions/0029)
--
-- Metin aramasi token duzeyinde aday kapisi uyguluyor. Gercek katalogda
-- basliklar karisik dilde: "Wireless Mouse", "Sneaker", "Cardholder". Kullanici
-- "kablosuz mouse", "spor ayakkabi", "cuzdan" yazinca kapi dogru olarak
-- eslesme bulamiyordu. docs/search.md: esanlamlilar sozlukte, veritabaninda
-- durur ki kod degismeden eklenebilsin.
--
-- Neden mevcut bir tur degil: 'category' satirlari ayristiricida kategori
-- FILTRESINE doner (kategori ipuclari kaba, 0027); 'material'/'style' anlam
-- olarak yanlis. 'synonym' filtre uretmez, yalnizca metin kapisinda ayni
-- `normalized` degerini paylasan yuzeyleri alternatif yapar.
--
-- Genisletici: CHECK yalnizca yeni bir deger kabul eder, mevcut satirlar
-- etkilenmez. Baslangic seti gercek bootstrap katalogundaki bosluklardan
-- (0027) secildi; ON CONFLICT DO NOTHING — elle eklenmis satiri ezmez.

ALTER TABLE lexicon DROP CONSTRAINT lexicon_kind_check;
ALTER TABLE lexicon ADD CONSTRAINT lexicon_kind_check
    CHECK (kind IN ('color','category','brand','size','material','style','synonym'));

INSERT INTO lexicon (kind, surface, normalized) VALUES
    ('synonym', 'kablosuz', 'kablosuz'),
    ('synonym', 'wireless', 'kablosuz'),
    ('synonym', 'sneaker', 'sneaker'),
    ('synonym', 'spor ayakkabı', 'sneaker'),
    ('synonym', 'spor ayakkabısı', 'sneaker'),
    ('synonym', 'cüzdan', 'cuzdan'),
    ('synonym', 'kartlık', 'cuzdan'),
    ('synonym', 'cardholder', 'cuzdan'),
    ('synonym', 'wallet', 'cuzdan'),
    ('synonym', 'kulaklık', 'kulaklik'),
    ('synonym', 'headphone', 'kulaklik'),
    ('synonym', 'headset', 'kulaklik'),
    ('synonym', 'earphone', 'kulaklik'),
    ('synonym', 'klavye', 'klavye'),
    ('synonym', 'keyboard', 'klavye'),
    ('synonym', 'battaniye', 'battaniye'),
    ('synonym', 'blanket', 'battaniye'),
    ('synonym', 'deri', 'deri'),
    ('synonym', 'leather', 'deri'),
    ('synonym', 'güneş kremi', 'gunes-kremi'),
    ('synonym', 'sunscreen', 'gunes-kremi'),
    ('synonym', 'sun cream', 'gunes-kremi'),
    ('synonym', 'lamba', 'lamba'),
    ('synonym', 'lamp', 'lamba'),
    ('synonym', 'tişört', 'tisort'),
    ('synonym', 't-shirt', 'tisort')
ON CONFLICT (kind, surface) DO NOTHING;
