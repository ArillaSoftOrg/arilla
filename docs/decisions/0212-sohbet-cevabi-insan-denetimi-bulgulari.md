# 0212 — Sohbet sonuç cevabı: insan denetimi bulguları ve doğrulayıcı sıkılaştırması

**Tarih:** 15 Kasım 2026 · **Durum:** kabul edildi · **Bayrak:** `CHAT_RESULT_ANSWER` (kapalı, değişmedi)
· **Migration:** yok · **İlgili:** karar 0203 (pilot), 0211 (sekme tutarlılığı)

## Denetim sonucu

Pilot koşusunda doğrulayıcının kabul ettiği 134 cevap insan tarafından denetlendi (kararlar bir AI ön
taslağından başladı; kullanıcı ürün kanıtlarıyla karşılaştırıp onayladı). Kayıt:
`docs/eval-data/chat-answer-pilot/2026-11-15-full/audit.json`.

| Karar | Sayı | Oran |
|---|---|---|
| Doğru | 96 | %71,6 |
| Kanıtsız iddia | 15 | %11,2 |
| Yanlış | 5 | %3,7 |
| Niyet dışı | 18 | %13,4 |

Kritik (kanıtsız + yanlış) **20**; karar 0203 çıkış ölçütü (≥100 denetlenen cevapta kritik 0)
**karşılanmadı**.

## 20 kritik hatanın kök nedenleri

- **Fiyat: 0.** Hiçbir kritik hata yanlış ya da delilsiz fiyat değil; sayı doğrulaması çalışıyor.
- **Kanıtsız ürün özelliği/işlev/etki: 8.** "daha hafif" (2), "kapsamlı özellikler", "geniş özellik
  setleri", "beslenme gereksinimlerini karşılamak üzere geliştirilmiş", "beslenme takibi", "iPhone ile
  eşleşebilen", "sınav stresi". Model başlıkta olmayanı kendi bilgisinden tamamlıyor.
- **Yanlış çıkarım: 12.** Dördü **yanlış yokluk iddiası**: başlıkta bilgi varken "hiçbirinde yok"
  (`Cotton` varken "pamuklu yok", `Silikon/TPR` varken "materyal yok", `9 W` varken "teknik detay yok",
  `iPhone … 16` varken "iPhone 16 ifadesi yok"). Yedisi amaç/bağlam/sınıflama çıkarımı (klavyeyi
  "taşıma ekipmanı" sayma, "orta segment", "klasik bir seçenek", "küçük oda için daha uygun"). Biri
  verilmeyen kaynak ("açıklamalarında").
- **Doğrulayıcı:** 20'sinin tamamı koşu anındaki doğrulayıcıdan geçti. 16'sı kelime/kalıp açığıydı (4'ü
  aynı gün yapılan sıkılaştırmayla, 12'si bu kararla kapandı). 4'ü (yanlış yokluk) yapısaldır: yokluk
  cümlesi dürüst cevabın kendisi olduğundan muaftır ve doğruluğu kelime kuralıyla sınanamaz.

Niyet dışı 18 cevabın 10'u "hangisi daha uygun" türündedir: kurallar amaç çıkarımını yasakladığı için
model soruyu yanıtlamadan fiyat sıralamaya çekiliyor. Güvenli ama yardımcı değil.

## Karar

1. **Doğrulayıcı** (`answer.ts`): ihtiyaç varsayan çerçeve ("… arıyorsanız", "… istersen"), fiyat dışı
   karşılaştırma ("daha hafif/sade"; fiyat ve teklif karşılaştırması serbest), üretim amacı/etki ("… için
   üretilmiş", "geliştirilmiştir", "yardımcı olabilir"), yetenek ("eşleşebilen"), öznel sınıflama ("orta
   segment", "klasik bir seçenek") reddedilir; yokluk söyleyen yan cümlede serbesttir. Modele verilmeyen
   kaynak ("açıklamalarında") her cümlede reddedilir. Reddedilen paragraf gösterilmez; hiç paragraf
   kalmazsa modelsiz olgusal özet gösterilir (karar 0203).
2. **Prompt** (`interpreter.ts`): yokluk demeden önce tüm başlıkları (İngilizce dahil) kontrol et ve
   varsa alıntıla; amaca uygunluk sorusunda başlıklar ayırt etmiyorsa bunu açıkça söyle; "daha uygun
   fiyatlı" sorusunda en düşük fiyatlıyı adıyla belirt; doğrulayıcının reddettiği kalıpları kullanma.
3. **Regresyon:** `answer-audit.test.ts` etiketli 134 cevabı her koşuda yeniden doğrular.

## Ölçüm ve sınırlar

Kayıtlı ham çıktıların yeniden doğrulanması (model çağrısı yok): kanıtsız iddia sayılan 15 cevabın 9'u
tamamen reddediliyor, 6'sında sorunlu paragraf atılıyor; doğru sayılan 96 cevabın 95'i aynen kalıyor.

- Kurallar bu 134 cevaba göre ayarlandı; aynı kümede ölçülen iyileşme **iyimserdir** ve bağımsız bir
  ölçüm değildir. Paragrafı atılan 6 cevabın kalan metni yeniden denetlenmedi.
- **Bilinen açık:** dört yanlış yokluk cevabı hâlâ geçiyor (testte `KNOWN GAP`). Kalıcı çözüm, başlıktan
  çıkarılmış yapılandırılmış öznitelik gerektirir (Faz 8); o zaman "pamuklu yok" iddiası veriyle sınanır.
- Prompt değişikliğinin etkisi **ölçülmedi** (ücretli çağrı yapılmadı); niyet dışı ve yanlış yokluk
  oranlarının düştüğü iddia edilemez.
- Reddedilen: yokluk cümlelerini tümden yasaklamak (dürüst "bilgi yok" cevabını da öldürür); soru
  sözcüklerini başlıklarla eşleştiren bir çelişki denetimi (kapsamı "diğer ürünler" gibi sınırlanan doğru
  cevapları da reddediyordu ve dört vakanın yalnız birini yakalıyordu).

## Canlı pilot

`CHAT_RESULT_ANSWER` kapalı kalır. Tek hesapla sınırlı pilot için ek önkoşul: üretim kataloğunda
tekliflerin neredeyse tamamı yurt dışı fiyatlıdır ve `toResultFacts` yaklaşık fiyatı modele vermez
(`price_try = null`); gerçek veride cevaplar büyük ölçüde fiyatsız kalır ve kartta görünen kurla
çevrilmiş fiyatla çelişen "fiyat belirtilmemiş" cümleleri üretebilir. Bu karar verilmeden pilot açılmaz.
