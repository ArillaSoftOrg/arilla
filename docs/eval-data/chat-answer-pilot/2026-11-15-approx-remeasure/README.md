# Faz 7 yeniden ölçüm: yaklaşık fiyatlı gerçekler (15 Kasım 2026)

Karar 0213 sonrası (yaklaşık TL fiyat + kur tarihi, doğrulayıcı ve istem güncellemesi) 82 vaka, 82 gerçek
Gemini çağrısı, ~$0,110 (tavan 100 çağrı / $0,12; hiçbiri aşılmadı). **Bu klasörde hiçbir insan kararı
yoktur**: `audit.json` içindeki `review.verdict` alanları boştur. Aşağıdaki gözlemler yapay zekâ
okumasıdır, insan onayı DEĞİLDİR.

## Koşul

- `--approx-prices`: AliExpress ürünlerine **sentetik**, deterministik yaklaşık TL fiyat (90-1800) ve kur
  tarihi (`2026-11-13`) verildi. Gerçek üretim biçimine uyar (kart fiyatı kurla çevrilmiş), ama sayılar
  gerçek katalog fiyatı değildir.
- 82 vaka: önceki 20 kritik + 18 niyet dışı + 32 doğru (örnek) + 12 YENİ fiyat odaklı vaka
  (`powerbank-11..12`, `car_acc-09..10`, `earbuds-10..11`, `kitchen-11..12`, `phone_case-09`, `gaming-08`,
  `desk_lamp-09`, `tools-08`). Önceki 70 vaka daha önce görülmüştü ve doğrulayıcı onlara göre ayarlandı: bu
  yüzden o kısım BAĞIMSIZ değildir. Yalnız 12 yeni vaka görülmemiştir.

## Otomatik sonuçlar (koşu anındaki doğrulayıcı)

| Grup | Vaka | Doğrulandı | Yedek özete düştü |
|---|---|---|---|
| Önceki kritik | 20 | 19 | 1 |
| Önceki niyet dışı | 18 | 15 | 3 |
| Önceki doğru (örnek) | 32 | 28 | 4 |
| Yeni fiyat vakaları | 12 | 10 | 2 |
| **Toplam** | **82** | **72 (%87,8)** | **10** |

Gecikme p50 2,19 sn, p95 2,98 sn; tur başı $0,00135; ortalama 3.021 girdi / 394 çıktı token.

## Yapay zekâ okumasında görülenler (insan onayı değil)

- Yaklaşık fiyat çoğu cevapta "yaklaşık" diye etiketlendi; tarih yalnız verilen kur tarihiyle söylendi
  (`earbuds-11`), uydurma tarih görülmedi.
- **Yanlış "en uygun/en ucuz" iddiaları** (yeni): model fiyatı olan ürünler arasında yaklaşık fiyatlıları
  karşılaştırmaya katmadı (`earbuds-01`: 549 TL "en uygun", listede 112 TL; `perfume-01`: 249 vs 235;
  `kitchen-08`: 1099 vs 149). Karar 0213 güncellemesiyle doğrulayıcı bunu yakalar.
- "Fiyatlar günceldir" (`kitchen-11`, kesin TRY fiyatlar için) kanıtsız; doğrulayıcı artık reddeder.
- Kargo/vergi sorusu (`car_acc-09`) cevaplanmadı: fiyat listelendi, "bu bilgi yok" denmedi. İstem güncellendi,
  etkisi ölçülmedi.
- Başlıkta bilgi varken "yok" (`desk_lamp-04` "Eye Protection", `women_fashion-04` "Cotton"): hâlâ sürüyor.
- Niyet dışı kümede model bu sefer çoğunlukla fiyat bilgisiyle yanıt verdi; 18'in kaçının gerçekten niyete
  uygun olduğu insan denetimi olmadan söylenemez.

## Sınırlar

Yeni 12 vaka dışında kümeye göre ayarlandı; fiyatlar sentetik; yaklaşık fiyat doğrulayıcı kuralları bu
koşudan SONRA güncellendi (kayıtlı ham çıktıların yeniden doğrulaması: 72 -> 68 doğrulanan cevap). Bu
koşuyu insan denetimine sokmak için `eval:chat-answer-review` kullanılabilir.
