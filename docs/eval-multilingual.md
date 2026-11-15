# Çok dilli değerlendirme kümesi (iskelet, insan etiketi bekliyor)

Konum: `packages/core/src/search/eval/multilingual/`. Model çağrısı, veritabanı, ağ yok; yalnız dosya.
Etiketleme yönergesi: `docs/eval-multilingual-yonerge.md`.

**Durum: etiketsiz.** Hiçbir kayıtta insan etiketi yok. `label_source = human` olan kayıt sıfırdır;
sistem karşılaştırması için gereken tek şey kullanıcının dolduracağı CSV'dir.

## Şema (dilden bağımsız)

| Dosya (`data/`) | İçerik |
|---|---|
| `languages.json` | Dil kaydı: BCP-47 `tag`, `status` = `active` (veride var) / `open` (açık, eklenebilir). Başlangıç: `tr`, `en`, `de` aktif; `fr`, `es`, `ar`, `ru`, `nl`, `it`, `pt` açık. `und` yalnız belge dili. |
| `queries.json` | `intents[]` (niyet türü, ipucu, dilim) ve `queries[]` (niyet başına dil başına bir metin). |
| `candidates.json` | `items[]`: (sorgu, belge) çifti, `query_lang`, `doc_lang`, `label_source`, `label`, `ai_preliminary_label`. |
| `pool-provenance.json` | Belge başına havuz kaynağı ve hangi sistemlerin getirdiği. **Etiketlemeden önce açılmaz.** |
| `labels-template.csv` | Kullanıcının dolduracağı kör CSV (UTF-8 BOM, Excel uyumlu). |

- Dil çifti saklanmaz, türetilir: `query_lang>doc_lang` (`languagePair`). Kodda dil listesi yoktur.
- **Yeni dil eklemek yalnız veridir:** `languages.json`'a satır, her niyet için `queries.json`'a bir
  sorgu satırı (`text_source: manual_draft`, `translation_status: draft_unverified`), `candidates.json`
  ve CSV'ye `ML-I..-<dil>` satırları. Kod, doğrulayıcı ve metrikler değişmez (testte `fr` ile gösterilir).
- `text_source`: `original` (E4/E3a'daki gerçek sorgu), `existing_draft` (E4 çok dilli deneyinde elle
  yazılmış İngilizce/Almanca), `manual_draft` (bu işte elle yazıldı). Çeviri doğruluğu **insan
  kontrolü bekliyor**: `translation_status` `draft_unverified`; kontrol sonrası `human_verified`.
- `expected_hint` (başlık regex'i) yalnız **ipucu**dur: örnek seçerken ve okurken yardımcıdır; etiket
  değildir, hiçbir metrik okumaz.
- `label_source`: `human` | `ai_preliminary` | `none`. `label` yalnız `human` iken dolu olabilir.
  `ai_preliminary_label` ayrı bilgi alanıdır (E4 AI önerisi, `oneri_puan_0_3`); yalnız Türkçe sorgu
  satırlarında ve yalnız E4 etiket havuzundan gelen 94 satırda var. Metriğe girmez.

## Sayılar

- 28 niyet (13 kategori, 4 teknik, 4 aksesuar/parça, 3 doğal dil, 2 model numarası, 1 olumsuzluk,
  1 katalogda yok beklenen), 84 sorgu (36 `original`, 25 `existing_draft`, 23 `manual_draft`).
- 504 aday satırı = 28 niyet x 3 dil x 6 belge; her sorgu dilinde 168 satır (dil dengeli).
  Aynı 6 belge üç dilde de sorulur (dilden bağımsızlık ölçülebilir).
- 161 benzersiz belge (E4 katalog anlık görüntüsü 119, E3a 42). Belge dili tahmini (`doc_lang_guess`,
  basit sezgisel): ~%95 `en`, az sayıda `tr`, `de`, `ru`, `pt`.
- Dil çifti dağılımı: `tr>en` 159, `en>en` 159, `de>en` 159; `x>tr` 5'er, `x>de` 2'şer, `x>ru`/`x>pt` 1'er.
  **Sorgu dili dengeli, belge dili dengesiz** (havuz kaynağı İngilizce AliExpress ağırlıklı).
  `tr>tr` ve `de>de` kırılımları şimdilik istatistiksel olarak anlamsızdır; Türkçe belge eklenmeli (aşağıda).

## Etiket CSV'si ve süre tahmini

Sütunlar: `item_id, query_id, query_lang, query_text, doc_title, doc_lang_guess, label, annotator, notes`.
Sistem, sıra, AI önerisi, ürün kimliği sütunu yoktur; satırlar dilim içinde dil bloklarına ve
belge sırası karışık olacak şekilde dizilidir (aynı belge üç blokta farklı yerlerde).
`label`: 0 ilgisiz, 1 zayıf/ilişkili, 2 ilgili ama fark var, 3 tam karşılar.

- 4 dilim: 126 + 108 + 126 + 144 satır (niyet sayısı 7/6/7/8). Dilimler tür karışık seçildi.
- Tahmin: satır başı 15-25 sn (yalnız başlık okunur) => **ilk dilim ~35-50 dk, tamamı ~2-3,5 saat.**
  Tek dilim bile `tr>en`, `en>en`, `de>en` kırılımını verir (sorgu başına 6 belge).
- Doldurulmuş CSV `mergeHumanLabels(items, parseLabelCsv(text))` ile işlenir: yalnız dolu `label`
  **ve** dolu `annotator` olan satır `human` olur; kapsam dışı etiket, bozulmuş `query_id` hata verir.

## Ölçü (`metrics.ts`)

`evaluateMultilingual(items, runs, {k=10, relevantMin=2})`: sistem başına `overall`, `byQueryLang`,
`byPair` (nDCG@k, P@k, `judgedFraction`). Kurallar:
- Yalnız `label_source = human` etiketler girer; `ai_preliminary_label` hiçbir yerde okunmaz.
- Etiketi olmayan belge ilgisiz sayılır (alt sınır); `judgedFraction` bunu gösterir. İnsan etiketi olmayan
  sorgu ve insan etiketine göre ilgili belgesi olmayan sorgu ortalamaya girmez (`skipped`).
- Dil çifti kırılımı: o belge dilindeki belgelerle sıra korunarak yeniden kesilir, ideal de o dilin
  etiketlerinden; böylece "Türkçe sorgu İngilizce belgeyi ne kadar iyi buluyor" ayrı görülür.
- Doğrulayıcı: `validateDataset` (BCP-47 şekli, kayıtlı dil, `human` için etiket+annotator, `human`
  olmayana etiket yok, tekrar yok). Testler: `multilingual.test.ts` (21 test).

## Sızıntı ve yanlılık notları

- **Havuz sistemlere bağlıdır.** E4 etiket havuzu (94 belge): lexical, yoğun (BGE-M3) ve hibrit ilk
  sonuçları, tür sondaları; ek 25 belge `insan-kontrol-*` (hedefli, cplus, e4b) havuzlarından.
  E3a belgeleri (42): metin + Jina + hibrit ilk 10 ve kural sondaları (E3a raporu: Jina'ya
  yanlı). Bu yüzden yeni bir sistem havuzun dışında kalan iyi belgeleri "ilgisiz" cezalandırılır;
  sonuçlar **havuz-içi alt sınırdır**, tam katalog geri çağırma ölçmez.
- **Seçim ipucu kullandı:** her niyetten 3 ipucu-eşleşen + 3 eşleşmeyen belge alındı ki etiketler 0/yüksek
  karışsın. Bu, ipucu regex'ine eşleşen belgelerin oranını suni yükseltir; mutlak P@k yorumlanmamalı,
  sistemler arası **göreli** karşılaştırma ve dil kırılımı yorumlanmalı.
- **Kör sıra:** CSV'de sistem bilgisi yok; `pool-provenance.json` (`retrieved_by_systems`) etiketleyici
  tarafından açılmamalı. 67 belgede (tümü E3a + E4 ek havuzlar) sistem bilgisi zaten kayıtlı değil.
- **AI ön etiketi** E4 AI önerisidir (tek model, insan onayı yok, 59 satırı "düzeltildi"); etiketleyiciye
  gösterilmez. Etiket sonrası kendi etiketinle karşılaştırılıp AI güvenilirliği ölçülebilir; metriğe girmez.
- **Belge dili ve katalog:** E4/E3a havuzları ağırlıkla İngilizce AliExpress. Türkçe belge (Hepsiburada 2.017
  ürün) yok denecek kadar az. Dil çifti dengesi için bir sonraki adım: Türkçe/Almanca belge içeren yeni havuz
  (ayrı iş; model çağrısı gerektirir).
- **Çeviri kayması:** bazı mevcut taslaklar birebir değil (E4 `Q74` olumsuzlaması "bluetooth" idi; burada
  "kablosuz değil"e çevrildi). Etiketleme öncesi `queries.json` çevirileri bir insan tarafından gözden
  geçirilmeli; geçince `translation_status = human_verified`.
- E3a ve E4 kimlikleri farklı katalog anlık görüntüleridir; `doc_id` önek taşır (`e3a:`, `e4:`).
- Aynı belge üç dilde tekrar sorulduğu için etiketleyicide çapa etkisi olabilir; dil blokları ayrı
  yerleştirildi ama tam önlenmez. Dilimler arası tutarlılık için iki etiketleyici (en az bir dilim) önerilir.
