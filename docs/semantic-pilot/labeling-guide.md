# İnsan etiketleme: iş akışı ve yönerge (200 ürünlük pilot, karar 0170)

Amaç: arama sonuçlarının doğruluğunu **kural tabanlı etiketlerden bağımsız** ölçmek. İki bağımsız değerlendirmeci aynı 240 eşleşmeyi
birbirinin cevabını görmeden etiketler; uyum ölçülür, anlaşmazlıklar üçüncü kişiyle çözülür. Etiketler tamamlanmadan arama doğruluğu hakkında iddia yapılmaz.

## Dosyalar

| Konum (`docs/semantic-pilot/human-eval/`) | Kime | İçerik |
|---|---|---|
| `rater_A/` (`labeling_pool_A.csv`, `query_targets_A.csv`, `catalog_for_absence_check.csv`, `YONERGE.md`) | **Değerlendirmeci A** | 240 satır, 38 sorgu hedef tablosu, 198 ürünlük katalog listesi, kısa Türkçe yönerge |
| `rater_B/` (aynı dosyalar, `_B`) | **Değerlendirmeci B** | Aynı içerik, **farklı satır sırası** (B'de sorgu sırası ters, sorgu içi ayrı karıştırma), `labeler=B` |
| `labeling_pool.csv`, `query_targets.csv` | Koordinatör | Ana (boş) havuz; bütünlük kontrolü ve birleştirme için |
| `internal/` (`pool_key.csv`, `auto_labels.csv`, `p200_run.json`) | **Yalnız ölçüm kodu** | Yöntem/sıra/benzerlik, kural etiketleri, ham sıralamalar. **Değerlendirmeciye verilmez.** |

Değerlendirmeciye yalnız kendi `rater_X/` klasörü verilir. Dosyalarda yöntem, sıra, skor yoktur; görünen alanlar: öğe kimliği, sorgu, ürün kimliği, **başlık**, **kategori**.
Ürün görseli, marka (hepsi boş) ve fiyat (yer tutucu değer, anlamsız) yoktur; başlık ve kategori anlamak için yeterlidir ama başlıklar anahtar sözcükle doldurulmuş olabilir
→ yönergede "asıl ürünü seçin" kuralı ve `unclear`/`KARARSIZ` yolu vardır.

### Neden 36 sorgu (38 değil)?
Havuz, üç yöntemin ilk-10 sonuçlarının birleşimidir. `yoga mat` ve `yoga matı` sorgularında **üç yöntem de 0 sonuç döndürdü** ve kural etiketine göre ilgili ürün de yoktu (`semantic-review/pilot200/p200_run.json`),
bu yüzden havuzda satırları yok. `query_targets.csv` 38 sorguyu içerir. Bu iki sorgu için değerlendirmeci `catalog_for_absence_check.csv`'yi tarayıp ilgili ürün olmadığını doğrular
(`note` = `KATALOGDA YOK`); ölçümde bu sorgular `verified_absent` olarak ayrı raporlanır, ortalamaya girmez, ilgisiz de sayılmaz. Katalog listesinden iki açık içerikli ürün çıkarılmıştır.

## Etiket şeması

### `relevance(0/1/2)` — sorgu ile ürün ilgisi
- **2 = Doğrudan ilgili:** ürün, sorgunun aradığı şeydir.
- **1 = Kısmen ilgili:** aynı ürün ailesi/cihaz ama aranan tür değil, ya da özelliklerin bir kısmı uymuyor.
- **0 = İlgisiz.**

### `result_type(...)` — ürünün KENDİ türü (sorgudan bağımsız)
`main` ana ürün · `accessory` aksesuar (kılıf, stand, kablo…) · `part` yedek parça (pil, filtre, ped, nozul…) · `other` bunların dışı · `unclear` başlıktan anlaşılmıyor.

### `query_target_type(...)` — `query_targets_X.csv`'de, sorgu başına bir kez
Sorgunun aradığı tür: `main` · `accessory` · `part` · `unclear`. İlgililik ile ürün türü **ayrı kararlardır**:
"laptop battery" sorgusunda pil `relevance=2`, `result_type=part` olur; "men pants" sorgusunda kemer `relevance=0`, `result_type=accessory`.

### Kararsız kalınan eşleşmeler (şemayla uyumlu)
Boş bırakmayın: **en yakın değeri seçin** ve `note` alanını `KARARSIZ:` ile başlatıp nedenini yazın (ör. `KARARSIZ: başlık hem kemer hem pantolon diyor`).
Ürün türü anlaşılmıyorsa `result_type=unclear`. `KARARSIZ` işaretli satırlar `agreement` çıktısında sayılır ve hakem dosyasına otomatik girer (iki değerlendirmeci aynı değeri verse bile).
Hakem, anlaşmazlık ve kararsız satırlar için `final_relevance` ve `final_result_type_or_query_target` sütunlarını doldurur.

### Kurallar
1. Yalnız başlık ve kategoriye bakın; anahtar sözcük doldurulmuş başlıklarda asıl ürünü seçin.
2. Dil önemli değil: Türkçe sorgu İngilizce başlıkla eşleşebilir ve tersi.
3. Boş alan = "değerlendirilmedi" (0 değildir); havuzda olmayan ürün "ilgisiz" demek değildir.
4. Uygunsuz/yetişkin içerik görürseniz etiketlemeyin, `note`'a `uygunsuz içerik` yazın (havuzda bilinen açık içerik yoktur; bkz. rapor §6).
5. Başka değerlendirmeciyle konuşmayın, dosyasını görmeyin; yöntem/skor aramayın.

## Excel / LibreOffice ile doldurma
- CSV dosyaları UTF-8 (BOM'lu) ve virgül ayraçlıdır; Excel'de çift tıklayıp açın. **Kaydederken “CSV UTF-8” biçimini seçin.**
  Türkçe Excel'in “CSV (noktalı virgülle ayrılmış)” çıktısı da okunur (ayraç otomatik algılanır).
- Yalnız `relevance`, `result_type`, `note` sütunlarını (ve `query_targets` için hedef tür/`note`) doldurun; kimlik/başlık/sorgu sütunlarını değiştirmeyin, satır silmeyin. Satırların sırasını değiştirebilirsiniz.
- `relevance` sütununa yalnız 0, 1 veya 2 yazın (Excel “Veri Doğrulama → Liste” ile `0,1,2` kısıtlayabilirsiniz; bu bir zorunluluk değil, `validate` hatalı değerleri yakalar).
- Bitirince dosyaları koordinatöre `labeling_pool_A.csv` / `query_targets_A.csv` (B için `_B`) adıyla gönderin.

## Koordinatör: komutlar (tümü `services/ingest` dizininden)

```bash
H=../../docs/semantic-pilot/human-eval
PY="python -m semantic_pilot.human_eval"   # venv: services/ingest/.venv (Windows: .venv/Scripts/python.exe)

# 0) (yalnız yeniden üretmek için) paketleri ana havuzdan üret; aynı girdi aynı paketi verir
$PY split-raters --pool $H/labeling_pool.csv --targets $H/query_targets.csv \
    --catalog <semantic-review/human-eval/catalog_for_absence_check.csv> --out $H

# 1) Geri gelen her dosya için bütünlük ve değer kontrolü (satır silinmiş/başlık değişmiş mi, geçersiz değer, tekrar)
$PY validate --pool <A>/labeling_pool_A.csv --targets <A>/query_targets_A.csv --master $H/labeling_pool.csv
$PY validate --pool <B>/labeling_pool_B.csv --targets <B>/query_targets_B.csv --master $H/labeling_pool.csv

# 2) İki değerlendirmeci uyumu (tam uyum, ağırlıklı kappa) + hakem dosyası (anlaşmazlık, eksik, KARARSIZ)
$PY agreement --pool-a <A>/labeling_pool_A.csv --pool-b <B>/labeling_pool_B.csv \
    --targets-a <A>/query_targets_A.csv --targets-b <B>/query_targets_B.csv --out adjudication.csv
#    adjudication.csv'yi 3. kişi doldurur: final_relevance(0/1/2) ve final_result_type_or_query_target

# 3) Uyumlu etiketler + hakem kararlarından nihai dosyalar (çözülmeyen alanlar BOŞ kalır, ölçüme girmez)
$PY merge --master-pool $H/labeling_pool.csv --master-targets $H/query_targets.csv \
    --pool-a <A>/labeling_pool_A.csv --pool-b <B>/labeling_pool_B.csv \
    --targets-a <A>/query_targets_A.csv --targets-b <B>/query_targets_B.csv \
    --adjudication adjudication.csv --out-dir final

# 4) Metrikler (nihai dosyalar; ilgili ürünü ≥3 olmayan sorgular için --min-query-relevant 3 de verilebilir)
$PY score --run $H/internal/p200_run.json --pool final/labeling_pool.csv --targets final/query_targets.csv --out sonuc.json
#    Her değerlendirmeci için ayrı da çalıştırılabilir (aynı komut, --pool/--targets A veya B dosyası)
```

`score` çıktısı: sorgu durumları (`ok`, `incomplete`, `no_labels`, `no_relevant`, `few_relevant`, `verified_absent`), her metrik için kaç sorgudan hesaplandığı, TR/EN kırılımı.

## Metrik tanımları ve sınırlar
| Metrik | Tanım / sınır |
|---|---|
| P@10 (≥1) ve (=2) | ilgili/10 — **sabit payda**: 10'dan az sonuç dönen yöntem cezalandırılır (kısa liste = eksik kapsama). `P@ret` dönen sonuç sayısına bölünmüş hâli; ikisi birlikte okunmalıdır. |
| nDCG@10 | kazanç 2^g−1; ideal sıralama **etiketli havuzdan**; ilk 10'da etiketsiz ürün varsa hesaplanmaz. |
| Recall@10 | etiketli ilgili ürünler üzerinden (havuz-tabanlı); etiketli ilgili ürün sayısı `--min-relevant` (3) altındaysa **hesaplanmaz**. |
| MRR | ilk ilgili sonucun sırasının tersi (ilk 10). |
| İlgisiz oranı | 0 etiketli / dönen sonuç. |
| Tür karışması | `query_target_type` ve `result_type` doluysa, ilk 10'daki main/accessory/part sonuçlardan türü sorgununkinden farklı olan oran. |
| Sıfır sonuç, sonuç/sorgu | etiketten bağımsız (yalnız çalışma çıktısından). |

**Eksik etiket metrikleri iyileştirmez:** bir yöntemin ilk 10'unda etiketsiz ürün varsa o sorgu **tüm yöntemler için** `incomplete` olur ve ortalamadan çıkar (aynı sorgu seti üzerinde karşılaştırma);
etiketsiz ürün hiçbir hâlde ilgisiz sayılmaz. Testler: `tests/test_human_eval.py`.
