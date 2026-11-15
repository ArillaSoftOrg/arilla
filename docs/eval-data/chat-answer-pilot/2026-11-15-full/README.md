# Faz 7 pilot koşusu (15 Kasım 2026): denetim kayıtları

Karar 0203 sonuç cevabı pilotunun tam koşusu. **Hiçbir insan kararı yoktur**: `audit.json` içindeki 155
kaydın hepsinde `review.verdict` boştur. Bu klasördeki "otomatik" sonuçlar insan onayı DEĞİLDİR.

| Dosya | İçerik |
|---|---|
| `audit.json` | Ham koşu kaydı (155 vaka, 147 çalıştı, 156 çağrı, ~$0,166). Her kayıtta modelin ham paragrafları, red nedenleri, otomatik bayraklar, boş `review`. |
| `audit.md` | Aynı kaydın okunur hâli (koşuyu üreten aracın çıktısı). |
| `review-pack.md` | **İnsan denetimi için:** 134 kabul edilmiş cevap; her biri için ürün gerçekleri tablosu, gösterilen cevap, delil alıntıları, görülmemesi gereken iddialar, otomatik sonuçlar ve boş karar alanı. |
| `review-sheet.csv` | Aynı 134 cevabın tablosu; `human_verdict` ve `human_notes` sütunları BOŞ. |

API anahtarı ya da başka gizli veri içermez (dosyalar bu amaçla tarandı; vakalar sentetik ürün
gerçekleridir).

## Koşunun sınırları

- Cevaplar, koşu anındaki doğrulayıcıyla kabul edildi. Sonradan sıkılaştırılan doğrulayıcı (bkz. karar
  0203 ve `1b349bd2`) aynı ham çıktıyı yeniden doğruladığında 3 cevabı reddeder: `backpack-01`,
  `watch-01`, `backpack-03` (yumuşak nitelik iddiaları). Paketteki `auto_current_validator` sütunu bunu
  gösterir; bu cevaplar kullanıcıya gitmeyecek olsa da denetimde yine incelenmelidir.
- Ürün gerçekleri sentetiktir (katalog biçimini taklit eder, bkz. `packages/core/src/eval/chat-answer-pilot-cases.ts`).
- Sekme tutarlılığı (karar 0211) bu koşudan SONRA düzeltildi; koşu sabit gerçek kümeleriyle yapıldı.

## İnsan denetimi için adımlar

1. `review-pack.md`'yi açın; her cevapta yalnız **ürün gerçekleri tablosuna** bakarak karar verin
   (`correct`, `unevidenced_claim`, `wrong`, `off_intent`). Kritik = `unevidenced_claim` + `wrong`.
2. Kararları `review-sheet.csv` içindeki `human_verdict` sütununa (ve istenirse `human_notes`) yazın.
   Hedef: ≥100 cevap denetlenmiş, kritik 0.
3. Tabloyu denetim kaydına işleyin (geçersiz karar ya da bilinmeyen vaka varsa hiçbir şey yazılmaz):

   ```
   pnpm --filter @arilla/core eval:chat-answer-review \
     --apply docs/eval-data/chat-answer-pilot/2026-11-15-full/review-sheet.csv \
     --audit docs/eval-data/chat-answer-pilot/2026-11-15-full/audit.json
   ```
4. Özeti alın (ücretli çağrı YOK):

   ```
   pnpm --filter @arilla/core eval:chat-answer --summarize docs/eval-data/chat-answer-pilot/2026-11-15-full/audit.json
   ```
5. Sonucu `CHAT_RESULT_ANSWER` kararına (karar 0203 çıkış kriterleri) taşıyın. Bayrak, denetim ve
   sekme tutarlılığı doğrulanmadan prod'da açılmaz.
