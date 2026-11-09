# Referans değerlendirme verisi — köken: **AI-assisted, user-reviewed**

Bu klasördeki etiketler **iki bağımsız insan değerlendirici tarafından üretilmemiştir.** Etiketler başlangıçta yapay zekâ tarafından hazırlanmış (A ve B dosyaları aynı kaynaktan),
sonra kullanıcı tarafından incelenip onaylanmıştır. A ile B arasındaki uyum **bağımsız insan değerlendiriciler arası güvenilirlik kanıtı değildir.**

| Dosya | Anlamı |
|---|---|
| `labeling_pool.csv` | 240 (sorgu, ürün) çifti; `relevance` **240/240 dolu** (A ve B her çiftte aynı değeri vermiş → `merge` ile uyumlu kabul edildi); `result_type` yalnız A=B olan **211** satırda dolu, **29** satır BOŞ (anlaşmazlık, çözülmedi) |
| `query_targets.csv` | 38 sorgu; `query_target_type` **34** sorguda dolu, **4** sorguda BOŞ (laptop keyboard, dizüstü klavye: A=unclear/B=main; car led light, araç led ışık: A=main/B=accessory); `KATALOGDA YOK` işareti `yoga mat` ve `yoga matı` için her iki tarafta var |
| `adjudication_open.csv` | Hâlâ insan kararı bekleyen 51 kayıt (29 ürün türü anlaşmazlığı/eksiği, 20 `KARARSIZ` işaretli çift — 2'si türde de anlaşmazlıklı —, 4 sorgu hedef türü). **Hiçbir satır otomatik/rastgele çözülmedi.** `final_*` sütunları boş |
| `score_result.json` | `human_eval score` çıktısı (sorgu bazında durum, metrikler, paydalar) |

Üretim komutları (gerçek çalıştırılan):
```
python -m semantic_pilot.human_eval agreement --pool-a A --pool-b B --targets-a ... --targets-b ... --out adjudication_open.csv
python -m semantic_pilot.human_eval merge --master-pool ../labeling_pool.csv --master-targets ../query_targets.csv --pool-a A --pool-b B --targets-a ... --targets-b ... --out-dir .
python -m semantic_pilot.human_eval score --run ../internal/p200_run.json --pool labeling_pool.csv --targets query_targets.csv --out score_result.json
```

Sınırlar: (1) 200 ürün, 38 sorgu; 10 milyon ürüne genellenemez. (2) `KARARSIZ` işaretli 20 çiftin ilgililik etiketi A=B olduğu için kabul edildi ama kullanıcı onayına rağmen belirsizdir; 20 sorguya dokunur (rapordaki duyarlılık analizi).
(3) Havuz yöntemlerin ilk-10'u + kural sondalarıdır; bir yöntemin hiç getirmediği ve sondalara girmeyen ilgili ürünler havuzda olmayabilir (bkz. `gider hortumu`).
(4) Mevcut etiketler gerekçesiz değiştirilmemiştir; eksik karar alanları çözümlenmiş kabul edilmemiştir.
