# Platform adapter fixture'lari (SENTETIK)

Bu dizindeki tum veri **uydurmadir**. Hepsiburada ya da Trendyol'dan gercek API/besleme
erisimimiz YOKTUR (karar 0118); `hepsiburada_sample.json` ve `trendyol_sample.json`,
bu tur kaynaklarin NASIL gorunebilecegine dair varsayimsal sekillerdir, gercek yanit
semalari degildir. Alan adlari, adresler ve kimlikler kurgusaldir
(`*.example.invalid`, `HBSAMPLE###`, `7000##`).

- `hepsiburada_sample.json`: tek saticili ilan stili, adreste `-p-`/`-pm-` kodu, TRY. 14 kayit (3 bozuk).
- `trendyol_sample.json`: pazar yeri stili, ayni ilani birden cok satici satar. 13 kayit (3 bozuk).
- `generic.csv`: noktali virgul, Turkce ondalik. 8 satir (1 bozuk).
- `generic.xml`: `g:` ad alanli besleme. 6 kayit (1 bozuk).

GTIN'ler: gecerli kontrol basamakli, eksik ve yer tutucu (`0000000000000`) karisik.
Test beklentileri (kayit/ret sayilari) bu dosyalara baglidir; degistirirsen testi guncelle.
