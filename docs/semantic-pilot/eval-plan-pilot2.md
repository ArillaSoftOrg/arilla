# Sonraki pilot (10–20 bin ürün) değerlendirme planı (karar 0170)

Bu belge yalnızca bir **plandır**: embedding/API çağrısı, etiket, algoritma/eşik değişikliği yoktur. Sorgu listesi: [`eval-plan-pilot2.csv`](eval-plan-pilot2.csv)
(üretici: `services/ingest/semantic_pilot/eval_plan.py`, test: `tests/test_eval_plan.py`).

## Boyut ve kapsam
- **110 sorgu, 58 kavram ailesi** (≥ 60 hedefi aşılır); 55 EN + 55 TR. TR/EN eş değerler **aynı ailede** tutulur; ailenin tamamı tek kümeye gider.
- Küme: **kalibrasyon 73 sorgu**, **bağımsız doğrulama 37 sorgu**. Doğrulama: ana ürün 19, aksesuar 10, yedek parça 8; EN 18, TR 19; kısa/orta/uzun sorgular; çok anlamlı ve kategori karışıklığı sorguları dâhil.
- Biçim: kısa (1–2 sözcük) 18, orta 80, uzun (≥ 5 sözcük) 12. Belirsizlik: çok anlamlı 12, kategori karışıklığı 14, "katalogda olmayabilir" kontrol 6, diğer 78.
- Tek dilli sorgular (3 yalnız TR, 3 yalnız EN) kasıtlı olarak dâhildir.

| Gereksinim | Karşılığı |
|---|---|
| Ana ürün / aksesuar / yedek parça | 33 ana, 14 aksesuar, 11 parça ailesi (uzun ve çok anlamlı sorgular dâhil) |
| Kısa sorgu | `mouse/fare`, `case/kasa`, `watch/saat`, `apple`, `powerbank`, `mouse pad`, `telescope/teleskop` |
| Uzun sorgu | hoparlör / iPhone kılıf / Xiaomi filtre / koşu ayakkabısı / USB-C hub / araç süpürgesi (hepsi EN+TR) |
| Çok anlamlı | `mouse/fare`, `case/kasa`, `watch/saat`, `apple`, `bebek arabası`, `mouse pad` |
| Kategori karışıklığı | `oyuncak araba`, `araç led ışık`, `dizüstü klavye` vs `piyano klavyesi`, `akıllı telefon` vs kılıf, `powerbank`, `mekanik klavye` |
| Katalogda olmayabilir | `yoga mat`, `telescope`, `acoustic guitar` (EN+TR); "olmayan" çıkarsa ayrı raporlanır, ortalamaya girmez |

## Veri sızıntısı önlemi
1. **Aile bazlı bölme:** `leakage_problems()` aynı ailenin iki kümede bulunmasını, aynı sorgu metninin iki kümede bulunmasını ve 200 ürünlük pilotta kullanılmış kavramların doğrulamada bulunmasını reddeder (testli).
2. 200 ürünlük pilotta **görülmüş 15 kavram aile yalnız kalibrasyona** girer; doğrulama sorguları o pilottaki sorgularla tamamen ayrıdır.
3. Kalibrasyon kümesi eşik/korumaları **seçmek ve hata analizi için** kullanılır. Ayarlar dondurulur (git etiketi/commit kaydı), doğrulama kümesi **tek kez** ölçülür; sonuç görüldükten sonra ayar değiştirilirse yeni bir doğrulama kümesi gerekir.
4. Etiketleyiciler yöntem/skor görmez (`labeling-guide.md`); havuz kalibrasyon ve doğrulama için ayrı üretilir.
5. Doğrulama sorgularının ürün başlıklarından türetilmediği, bağımsız bir kişi tarafından gözden geçirilmesi önerilir (bu planı yazan kişi katalogdaki gerçek başlıkları görmüştür; sorgu kavramları pazar yerlerindeki genel ürün adlarıdır).

## Ölçüm ve kabul koşulları
- Etiketleme: iki bağımsız değerlendirmeci, `relevance 0/1/2` + `result_type` + `query_target_type`; `agreement` komutu ağırlıklı kappa verir; anlaşmazlıklar üçüncü kişiyle çözülür.
- Havuz: her sorgu için metin/anlamsal/hibrit ilk 10 birleşimi + "kaçırılmış olabilir" sondaları (`human_eval build-pool`); etiketsiz ürün asla ilgisiz sayılmaz.
- Rapor edilecekler: P@10 (≥1 ve =2), P@ret, nDCG@10, MRR, ilgisiz oranı, tür karışması, sıfır sonuç, sorgu başına sonuç; **TR/EN ayrı**, aile bazında; durumlara göre ayrı sorgu sayıları (`ok/no_relevant/few_relevant/incomplete/no_labels`).
- "Katalogda yok" sorgularında ayrı rapor: 0 sonuç mu, ilgisiz sonuç mu? Yöntem başına yanlış pozitif sayısı.
- Havuz yeterince büyük olmalı: ≥ 10–20 bin ürün; her kalibrasyon/doğrulama sorgusunda **en az 3 insan-doğrulanmış ilgili ürün** beklenir, aksi hâlde sorgu `few_relevant` olarak ayrı raporlanır (ortalamaya girmez).
- Kabul koşulları ve eşikler (ör. "hibrit nDCG ≥ metin + δ", "ilgisiz oranı ≤ x") **etiketler görülmeden önce** yazılıp onaylanmalıdır; bu belgede bilerek sayısal hedef verilmemiştir (kanıtsız hedef olurdu).
- Bu planın hiçbir bölümü 10 milyon ürünlük arama doğruluğunun kanıtı sayılmaz; 10–20 bin ürünlük pilot yalnız ölçek öncesi kontroldür.
