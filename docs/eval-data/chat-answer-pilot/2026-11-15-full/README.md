# Faz 7 pilot koşusu (15 Kasım 2026): denetim kayıtları

Karar 0203 sonuç cevabı pilotunun tam koşusu ve insan denetimi sonucu (karar 0212).

## Denetim sonucu

Doğrulayıcının kabul ettiği 134 cevabın tamamı denetlendi. Kararlar bir AI ön taslağından başladı;
kullanıcı her kararı ürün kanıtlarıyla karşılaştırıp onayladı (15 Kasım 2026).

| Karar | Sayı | Oran |
|---|---|---|
| `correct` | 96 | %71,6 |
| `unevidenced_claim` | 15 | %11,2 |
| `wrong` | 5 | %3,7 |
| `off_intent` | 18 | %13,4 |

Kritik (`unevidenced_claim` + `wrong`) **20**. Karar 0203 çıkış ölçütü (≥100 denetlenen cevapta kritik 0)
**karşılanmadı**. Kök nedenler ve yapılan düzeltmeler: `docs/decisions/0212-…`.

## Dosyalar

| Dosya | İçerik |
|---|---|
| `audit.json` | Koşu kaydı (155 vaka, 147 çalıştı, 156 çağrı, ~$0,166) ve 134 kabul edilmiş cevabın insan kararı (`review.verdict`, `review.notes`). Denetimden önceki hâli git geçmişindedir (`ffca89de`). |
| `audit.md` | Koşu kaydının okunur hâli (koşuyu üreten aracın çıktısı; karar içermez). |
| `review-pack.md` | Denetim paketi: her cevap için ürün gerçekleri tablosu, gösterilen cevap, delil alıntıları, otomatik sonuçlar. |
| `review-sheet.csv` | Boş denetim tablosu (şablon). |
| `review-sheet.reviewed.csv` | Onaylanmış 134 karar ve gerekçe; `audit.json`'a bu dosyadan işlendi. |

API anahtarı ya da başka gizli veri içermez (dosyalar bu amaçla tarandı; vakalar sentetik ürün
gerçekleridir). "Otomatik" sütunlar doğrulayıcı ve bayrak sonuçlarıdır; insan kararı değildir.

## Sınırlar

- Ürün gerçekleri sentetiktir (katalog biçimini taklit eder, bkz.
  `packages/core/src/eval/chat-answer-pilot-cases.ts`). Üretim kataloğunda tekliflerin neredeyse tamamı
  yurt dışı fiyatlıdır ve modele TL fiyat gitmez; bu koşu o durumu yalnız kısmen temsil eder.
- Cevaplar koşu anındaki doğrulayıcıyla kabul edildi. Karar 0212 sonrası doğrulayıcı aynı ham çıktıyı
  yeniden doğruladığında kritik 20 cevabın 10'unu tamamen reddeder, 6'sının sorunlu paragrafını atar;
  4 yanlış yokluk cevabı hâlâ geçer (bilinen açık). Kalan metinler yeniden denetlenmedi.
- Sekme tutarlılığı (karar 0211) bu koşudan sonra düzeltildi; koşu sabit gerçek kümeleriyle yapıldı.

## Komutlar (ücretli çağrı yok)

```
# doldurulmuş tabloyu kayda işle (geçersiz karar ya da bilinmeyen vaka varsa hiçbir şey yazılmaz)
pnpm --filter @arilla/core eval:chat-answer-review \
  --apply docs/eval-data/chat-answer-pilot/2026-11-15-full/review-sheet.reviewed.csv \
  --audit docs/eval-data/chat-answer-pilot/2026-11-15-full/audit.json

# özet
pnpm --filter @arilla/core eval:chat-answer --summarize docs/eval-data/chat-answer-pilot/2026-11-15-full/audit.json
```

`--apply` kaydı iki boşluk girintiyle yazar; işledikten sonra `npx biome format --write <audit.json>`
çalıştırın (CI biçim denetimi).
