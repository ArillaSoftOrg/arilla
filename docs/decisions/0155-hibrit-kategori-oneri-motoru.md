# 0155 — Hibrit kategori öneri motoru (V5 + dinamik + e5-small ONNX INT8)

Durum: kabul edildi (yerel/toplu öneri hattı); **üretimde çalıştırılmadı, hiçbir kategori yazılmaz.**

## Bağlam
V5 kaba ama çoğunlukla doğru atar; dinamik motor (karar 0154) özgül ama kural-yalnız. 400 ürünlük AI
değerlendirmesinde (insan etiketi değildir) ikisi de yetersiz kaldı: V5 ~%16 tam uyum (%85 "yakın"),
dinamik inceltme ~%50 yanlış; ham gömme tek başına ~%67 yanlış. Bölge sınırı + z-skor düzeltmesiyle
gömme kullanılabilir hâle geliyor ve kuralla birleşince en iyi üstten-3 adayı veriyor.

## Karar
Yeni, **yalnızca öneri üreten** hat (`services/ingest/classify/suggest/`); mevcut sınıflandırıcı,
`classifier_scope` ve ürün kategorileri değişmez, migration yok.

1. **Adaylar:** kaynak kategorinin Trendyol bölgeleri (`dynamic.regions_for`) içinde; başlık
   (`query: `) ile kategori tam yolu + yaprak adı (`passage: `) kosinüs benzerliği, kategori başına
   z-skorla düzeltilir (hubness). Bölge yoksa aday yok.
2. **Birleşim:** dinamik motorun `match` adayı önce gelir; gömmenin ilk 3'ünde aynı dalda ise
   `guclu`, tek başına `orta`, gömme tek başına ancak z ≥ 2,0 ve başka daldaki rakiple fark ≥ 0,6 ise
   `orta`, aksi `inceleme` (aday yine listelenir ama "kanıt yetersiz"). En fazla 3 aday, birbirinin
   atası/torunu olmayan; her biri gerekçeli (yol, kural kanıtı, z, kosinüs, cezalar).
3. **Cihaz/aksesuar/parça ve oyuncak:** başlık parça dili taşıyorsa parça olmayan düğüme, oyuncak dili
   taşıyorsa oyuncak olmayan düğüme z cezası. *Ölçüm: etkisi nötr* (AI etiketlerine göre top-1 132 ↔ 133);
   asıl kazanç dinamik motordaki `HEAD_MODIFIERS`/tam-ad kuralından geliyor. Karışıklık sürüyor.
4. **Model:** `intfloat/multilingual-e5-small`, sabit commit `614241f622f5…`, dinamik INT8 ONNX
   (`avx512_vnni`), yalnız `onnxruntime`+`tokenizers`+`numpy` (torch yok). `manifest.json` + kodda sabit
   SHA-256 (model, tokenizer); uyuşmazlıkta yükleme reddedilir (`verify_model_dir`). Model **yalnızca
   toplu işte**; web yolunda yüklenmez (değişmez kural 1 etkilenmez: istek yolunda model yok).
5. **Toplu çalışma:** `classify suggest run`: salt okunur bağlantı, kimlik sırası, parti sonu
   `fsync` + SQLite kontrol noktası (son ürün, çıktı ofseti, sayaçlar, model/ağaç/kural sürümü);
   yeniden başlatma çıktıyı kontrol noktasına KIRPAR (her ürün tam bir kez); farklı sürümle devam
   reddedilir; aynı (başlık, kaynak) çifti tekrar hesaplanmaz; `--threads`, `--max-rss-mb`,
   `--max-seconds`, `--sleep-ms`, SIGINT/SIGTERM'de temiz durma.
6. **Sürümler:** model (`e5-small-int8-<sha12>`), kategori ağacı (`id|yol|ad` SHA-256 ilk 16),
   öneri kuralı (`SUGGEST_VERSION`) her çıktı satırında ve `run.json`'da; sürüm değişince önbellek geçersiz.
7. **Bağımlılık:** `numpy` yalnızca `dev` ekinde (testler); çalışma bağımlılıkları `suggest` ekinde;
   model üretimi `model-build` ekinde. **Üretim imajına eklenmedi**; pilot öncesi ayrı karar.

## Ölçümler (yerel; AI etiketleri insan doğrulamalı değildir)
Bkz. `docs/ops.md` "Hibrit kategori önerisi". Özet: ilk 400 üründe AI etiketiyle yol uyumu (tam+ata/torun)
top-1: V5 %4 (iki ağaç, kıyas dışı), dinamik %23, E5 %22, hibrit %33; top-3: E5 %32, hibrit %41.
Bağımsız 400'de hibrit: `guclu` 56, `orta` 66, `inceleme` 278 (%69,5). Hız 80–95 ürün/sn, tepe ~650 MB.

## Reddedilen alternatifler
- Yalnız gömme (kapısız): alakasız dal oranı çok yüksek, güven puanı ayırt etmiyor.
- Daha büyük model (bge-m3): ~7× yavaş, kalite kazancı küçük.
- Öneriyi otomatik uygulamak: AI/hakem doğruluğu insan etiketiyle doğrulanmadı (karar 0139 §7).
- Çalışma zamanında HF indirmesi: bütünlük ve üçüncü taraf kuralı; model imaja önceden konur.
