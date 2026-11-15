# Çok dilli etiketleme yönergesi

Dosya: `packages/core/src/search/eval/multilingual/data/labels-template.csv` (Excel'de açılır, UTF-8 BOM'lu).
Önce `docs/eval-multilingual.md`'deki sızıntı notlarını okuyun. `pool-provenance.json` ve `candidates.json`'u
**açmayın** (sistem bilgisi ve yapay zeka önerisi içerir).

## Ne yapılır

Her satırda bir **sorgu** (`query_text`, `query_lang` dilinde) ve bir **ürün başlığı** (`doc_title`) var.
Soru: "Bu sorguyu yazan kişi bu ürünü görünce aradığını bulmuş olur mu?" Yalnız başlığa bakın; görsel,
fiyat, mağaza düşünmeyin. Ürün dili sorgu dilinden farklı olabilir; dilden bağımsız, **niyete** göre karar verin.

| `label` | Anlamı |
|---|---|
| 3 | Aranan ürünün kendisi; belirtilen tüm özellikler (boyut, model, teknik değer) uyuyor ya da çelişmiyor. |
| 2 | Doğru ürün türü ama önemli bir özellik farklı/eksik (renk dışı: kapasite, uyumluluk, yaş grubu, set/tekli). |
| 1 | İlişkili ama yanlış tür: aksesuar, yedek parça, yakın kategori, başka marka/model istenmişken genel ürün. |
| 0 | İlgisiz ya da sorgunun açık bir şartıyla çelişiyor (olumsuzlama: "kablosuz olmayan" için kablosuz ürün = 0). |

Kısa kurallar:
- Model numarası ya da marka isteniyorsa (`DCD771`, `DeWalt`): başlıkta yoksa en çok 1. Parça isteniyorsa ürünün kendisi 1.
- Doğal dil sorguda ("pili bitti, yedek batarya") niyeti çıkarın; uyumlu ürün 3, uyumsuzluğu belirsizse 2.
- Katalogda olmaması beklenen sorguda (ör. bulaşık makinesi) yakın ürün varsa 1, yoksa hepsi 0 kalabilir; bu normaldir.
- Emin değilseniz düşük etiketi seçin ve `notes`'a yazın. Başlık okunamıyorsa (başka dil) `notes`: `okunamadi`, etiket boş.
- Aynı ürünü farklı dilde sorgularla görürseniz tutarlı kalın; ama eski cevabınıza bakmak için geri dönmeyin.

## Doldurma

- `label`: yalnız 0, 1, 2, 3. `annotator`: adınız ya da kodunuz (zorunlu; boşsa satır **sayılmaz**).
- Başka sütunları değiştirmeyin (`item_id`, `query_id` bozulursa satır reddedilir).
- İlk dilim (`ML-0001` ile başlayan 126 satır, `slice 1`) ~35-50 dk. Önce yalnız onu doldurup geri verin.
- Çeviriler (`query_text`, `en`/`de`) taslaktır; yanlış/çok bozuk bir çeviri görürseniz `notes`'a `ceviri` yazın.
