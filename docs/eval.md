# Değerlendirme altyapısı (Faz 1A-1)

Amaç: arama, niyet, eşleştirme ve görsel benzerlik kalitesini **ücretli API
çağırmadan**, deterministik ve tekrarlanabilir ölçmek. Üretim eşikleri ve
ağırlıkları bu çalışmayla değişmez; yalnızca mevcut değerler ölçülür.

## Komutlar

| Alan | Komut | Gereksinim |
|---|---|---|
| Metrik birim testleri | `pnpm --filter @arilla/core test` (`src/eval/*`) | yok |
| Niyet | `pnpm --filter @arilla/core eval:intent [-- --json out.json]` | yok |
| Eşleştirme | `cd services/ingest && python -m resolve.eval_offline` | yok |
| Eşleştirme temel çizgi yenile | `... --write-baseline tests/fixtures/matching/baseline.json` | bilinçli karar |
| Görsel benzerlik | `python -m resolve.image_eval --dataset image_pairs.json` | önceden üretilmiş vektörler |
| Arama (canlı) | `node scripts/search-eval.ts --json run.json` | yerel DB + bootstrap katalog |
| Arama karşılaştırma | `pnpm --filter @arilla/core eval:search-compare -- temel.json yeni.json` | yok (iki JSON) |

Regresyon varsa karşılaştırma komutları çıkış kodu 1 döner.

## Metrikler

- Precision / Recall / F1, macro-F1: `packages/core/src/eval/metrics.ts`, `services/ingest/resolve/eval_metrics.py`
- Precision@5, NDCG@10, sıfır sonuç oranı: `packages/core/src/eval/search-eval.ts`
- Yanlış ürün eşleştirme oranı (FP / (FP+TN)): kuyruk ve otomatik kabul için ayrı
- Regresyon karşılaştırması: `compareRuns` (TS), `compare` (Python); metrik başına iyi yön, tolerans

## Veri setleri ve etiket sayıları (yalnızca doğrulanmış)

| Set | Doğrulanmış | Hedef | Dosya |
|---|---|---|---|
| Eşleştirme (metin, DB'siz) | 73 çift (32 aynı / 41 farklı) | 300 | `services/ingest/tests/fixtures/matching/pairs.json` |
| Eşleştirme (çapraz mağaza, DB'li) | 48 çift (33 / 15) | | `.../overlap_pairs.json` |
| Arama | 38 sorgu (8 "katalogda yok") | 150 | `packages/core/src/search/eval/bootstrap-queries.json` |
| Niyet | 25 vaka | 200–300 | `packages/core/src/eval/datasets/intent-golden.json` |
| Görsel benzerlik | 0 (ölçüm kodu hazır) | | `resolve/image_eval.py` biçimi |

Hedeflere ulaşılmadı; sayılar sahte etiketle doldurulmadı.

## Kurallar

- Bir örnek yalnızca insan doğrulamasıyla (`label_source: human` ya da kanıtı
  belgelenmiş) altın sete girer. Doğrulanmamışlar `candidates/` altında
  **etiketsiz** tutulur ve ölçüme girmez.
- Tekrar ve aşırı benzerlik `dataset-lint.ts` ile denetlenir (Jaccard ≥ 0.9).
- Test fixture'larına kişisel veri, gerçek kullanıcı sorgusu ya da ham görsel
  konmaz (kural 10, `docs/kvkk.md`); görsel için yalnızca vektör + etiket.
- Testler Gemini/Jina çağırmaz; `interpreter.test.ts` sahte sağlayıcı kullanır.

## Kapsam dışı (sonraki adımlar)

Faz 1A-2 (sonuç tabloları/migration), CI'a Python eval adımı (CI Python işi
ayrı PR'larda yürüyor), canlı Gemini niyet doğruluğu, gerçek Jina vektörleriyle
görsel set.

## Kalıcı kayıt (Faz 1A-2, karar 0096)

Koşu sonuçları `dataset_snapshot` / `ai_eval_run` / `ai_eval_case`, model çağrısı
hataları `ai_error_event` tablolarına `packages/core/src/eval/store.ts` ile yazılır.
Ham sorgu/metin/görsel/kullanıcı kimliği yazılmaz; vaka anahtarı fixture metninin
hash önekidir. Üretim çağıranlarına bağlama ve cron temizliği ayrı iştir.

## Yönetim paneli (Faz 1A-3, karar 0097)

`/yonetim/ai/kalite` kayıtlı koşuları okur; model çağırmaz. Anahtar sözleşmesi
`packages/core/src/eval/metric-keys.ts`. Koşuları veritabanına yazan komut (`--record`)
henüz yoktur; panel o zamana kadar "Henüz veri yok" gösterir.

## Kayıt (Faz 1A-4, karar 0098)

```
pnpm --filter @arilla/core eval:intent -- --record
node --experimental-transform-types --no-warnings scripts/search-eval.ts --record
python -m resolve.eval_offline --json > out.json
pnpm --filter @arilla/core eval:record-matching -- out.json --record
```

`--record` yoksa yazılmaz; yalnızca yerel DB. Aynı koşu tekrar yazılmaz. Görsel benzerlik
için etiketli veri olmadığından kayıt yolu yoktur.
