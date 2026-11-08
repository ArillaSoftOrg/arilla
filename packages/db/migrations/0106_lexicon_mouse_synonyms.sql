-- kind: data
-- 0106 — "fare" <-> "mouse" esanlamlilari (karar 0131 kalibi, 0087 devami)
--
-- Uretimde "kablosuz olmayan oyuncu faresi" sifir sonuc dondu: katalog basliklari
-- "Gaming Mouse" der, "faresi" hicbir baslikta gecmez ve sozlukte fare -> mouse esanlami
-- yoktu (oyuncu -> gaming/gamer 0087'de var). Ekli bicimler ayri yazilir: slot eslesmesi
-- katlanmis token ile birebirdir. Filtre uretmez, katalog verisine dokunmaz.
-- Yalnizca ekleme; ON CONFLICT DO NOTHING elle eklenmis satiri ezmez.

INSERT INTO lexicon (kind, surface, normalized) VALUES
    ('synonym', 'fare', 'fare'),
    ('synonym', 'faresi', 'fare'),
    ('synonym', 'fareyi', 'fare'),
    ('synonym', 'fareler', 'fare'),
    ('synonym', 'mouse', 'fare'),
    ('synonym', 'mice', 'fare')
ON CONFLICT (kind, surface) DO NOTHING;
