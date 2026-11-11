# 0184 — CPU embedding servisi, havuzlama kaydı ve altın vektör kanaryası

Durum: **kabul**. Migration yok. Aktif model değişmez (`jina-embeddings-v3`). İlgili: 0155, 0177,
0180, 0181, 0182 (embedding çıkarım servisi sözleşmesi).

## Bağlam

- 0182 kendi çıkarım servisi için istemci sözleşmesini (OpenAI `/v1/embeddings`) getirdi. Ancak
  servisin kendisi (çalışma ortamı, kaynak sınırı, ağ yalıtımı) yoktu.
- `validate_batch` sayı, boyut, sonluluk ve norm denetler. **Yanlış havuzlama** (BGE-M3'te CLS
  yerine mean, Qwen3'te last-token yerine mean), yanlış revizyon ya da eksik önek yine doğru
  boyutta birim vektör üretir. Kapı bunları geçirir ve vektör uzayı sessizce bozulur.
- Resmî `1_Pooling/config.json` (sabit revizyonlarda okundu): BGE-M3 `cls`, Qwen3-Embedding-0.6B
  `lasttoken` (prompt dahil), multilingual-e5-small `mean`. 0155'teki `OnnxEmbedder` yalnız
  mean yapıyordu ve dosya düzeni e5'e özgüydü.

## Karar

### 1. `pooling` kayıt alanı

- Değerler `cls | mean | last_token`.
- Kendi çalıştırdığımız sağlayıcılarda (`local_onnx`, `remote_http`) zorunlu, Jina'da yasak
  (havuzlama API'de yapılır; Jina kayıtları ve davranışı değişmez).
- `enrich.pooling` gerçek uygulamadır:
  - `OnnxEmbedder` havuzlamayı kayıttan alır.
  - `LocalOnnxTextProvider`, gömücünün kullandığı yöntem kayıtla aynı değilse kurulmaz.
- `last_token` sağ ve sol dolguyu doğru ele alır. `cls` sol dolguda hata verir.
- BGE-M3 `remote_http`'ye (TEI) taşındı, çünkü `OnnxEmbedder` e5'e özgüdür. `max_input_tokens`
  512 oldu (Qwen3 ile aynı karşılaştırma koşulu). Model devre dışı, tablosu yok, veri yok.

### 2. Altın vektör kanaryası (`enrich.canary`) — fail-closed

- **Altın dosya:** `enrich/golden/<model_id>.json`. Kanarya metinleri 8 ürün pasajı ve 4 sorgudur
  (Türkçe). Vektörler resmî referanstan, kayıttaki revizyonla üretilir
  (`enrich.golden_build`, sentence-transformers). Resmî havuzlama kayıtla aynı değilse üretim
  durur.
- **Kapı (`require_canary`):** Yazma öncesi `enrich.products --execute` içinde çalışır.
  Yalnızca kendi çalıştırdığımız modelleri kapsar. Şu durumlarda reddeder:
  - altın dosya yok, ya da kimlik, revizyon, havuzlama, boyut, normalizasyon, ön işleme veya
    önek kayıtla uyuşmuyor;
  - eşik ölçülmemiş ya da ölçüm kanıtı yok;
  - eşik 0,99'un altında;
  - herhangi bir kosinüs eşiğin altında;
  - bir çıktı kendi altın vektörü yerine başka bir metninkine daha yakın;
  - sağlayıcı hata veriyor.
- **Eşik tahminle konmaz:** `--measure --record-tolerance` gözlenen en düşük kosinüsten 0,0005
  pay düşer; sunucu ve imaj bilgisi kanıt olarak yazılır.
- **Ölçüm (yerel Docker, TEI cpu-1.9.4, 2 vCPU):**

| Model | Doğru havuzlama | Kosinüs | Eşik | Yanlış havuzlama (mean) |
|---|---|---|---|---|
| Qwen3-0.6B | last-token | 1,000000 (12/12) | 0,9994 | 0,46–0,78, kapı reddetti |
| BGE-M3 | cls | ≥ 0,99998 | 0,9994 | 0,77–0,84, kapı reddetti |

  BGE-M3'teki küçük fark, TEI'nin tanh yaklaşımlı GeLU kullanmasından gelir.

### 3. `embed-cpu` profili (`infra/compose.embed.yml`) — varsayılan kapalı

- Üretim yığınına eklenmez; dağıtım hattı onu çalıştırmaz.
- TEI `cpu-1.9.4` imajı digest'e sabitlidir.
- Model yalnızca salt okunur `/models/<dizin>`'den okunur:
  - TEI dizini bulamazsa indirmeyi **dener** (ölçüldü). Bunu internal `embed` ağı ve kapalı porta
    yönlendirilmiş `HF_ENDPOINT` keser.
  - Dizin `enrich.model_files` ile revizyon ve SHA-256'ya karşı doğrulanır.
- `ports:` yok; root olmayan kullanıcı; salt okunur kök dosya sistemi; `cap_drop ALL`;
  `no-new-privileges`; sağlık kontrolü; durdurma süresi; `pids_limit`.
- **Başlangıç tavanı 2 vCPU / 6 GB.** Yerelde ölçüldü: Qwen3 yüklemede ~3,2 GiB tepe yapar, 3 GiB
  limitte OOM olur; BGE-M3 ~2,7 GiB.
- **Eşzamanlılık:** `--max-concurrent-requests` girdi sayar, bu yüzden 64 (iki tam parti).
  `--max-batch-tokens 2048`.
- Model başına ayarlar `infra/embed/<model_id>.env` dosyasındadır. Parite testi, sunulan model
  adının ve havuzlamanın kayıtla aynı olduğunu denetler.
- **Girdi sınırı istemcidedir:** `RemoteHttpTextProvider`, `max_input_tokens`'ı aşan partiyi
  kırpmadan reddeder. TEI'de `--auto-truncate=false`, `--max-batch-tokens`'ın modelin en uzun
  girdisinden büyük olmasını ister ve bu bellek tavanını anlamsız kılar.

### 4. Ölçüm ve analiz araçları (yazmaz)

- `enrich.pilot` artık `remote_http` modellerini de ölçer (devre dışı olsa bile; pilot yazmaz)
  ve `canary_min_cosine` bildirir.
- `enrich.quality` salt okunur, örneklemeli veri kalitesi raporu üretir:
  - `TABLESAMPLE SYSTEM … REPEATABLE` kullanır ve her sorgu `EXPLAIN` kapısından geçer.
  - Toplam satır sayıları `reltuples` tahminidir.
  - Üretim için `--emit-sql` → psql (READ ONLY) → `--render` yolu vardır.

## Reddedilen

- **Eşiği sabit bir sayıyla koymak (ör. 0,99):** Yanlış havuzlama BGE-M3'te 0,84'e kadar çıkar;
  tahmini eşik ölçülmemiş bir sunucuyu geçirebilir.
- **Altın vektörü TEI'nin kendisinden üretmek:** Doğrulanan sistemle referans aynı olur. Referans
  resmî sentence-transformers'tır.
- **Servisi `compose.prod.yml`'ye profil olarak eklemek:** Dağıtım hattının dokunduğu dosyayı
  değiştirir. Ayrı dosya, KVM 8 / ayrı VPS / GPU'ya taşınabilir.
- **`--auto-truncate=false` + büyük `--max-batch-tokens`:** CPU'da bellek tavanını kaldırır.

## Sınırlar ve açık işler

- **Hız (yerel, 2 vCPU):** Qwen3 2,9, BGE-M3 6,5 metin/sn. Üretim CPU'su farklıdır; KVM 8'de
  `enrich.pilot` ile yeniden ölçülmeli. Bu hızla 12 M ürünün tamamı 2 vCPU'da haftalar sürer
  (E3 kararının girdisi).
- **BGE-M3 pickle riski:** BGE-M3'ün sabit revizyonunda yalnızca `pytorch_model.bin` (pickle)
  vardır. Üretime almadan önce yalıtılmış ortamda safetensors'a çevrilmeli (E3).
- **Lisans onayı:** `license_verified=false` kalır.
- **1024 boyutlu tablo:** 1024 ailesinin tablosu yok. Migration 0111 yalnızca pilot kazanırsa
  yazılır.
