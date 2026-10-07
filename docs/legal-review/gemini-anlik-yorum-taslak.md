# TASLAK — Anlık Gemini sorgu yorumu için hukuki değişiklikler

**Durum:** Kamuya açık metin değişiklikleri 7 Ekim 2026'da uygulandı
(`/gizlilik` §2.2, §5; `/kvkk-aydinlatma` §5); LIA güncellemesi ve aşağıdaki
sorular hâlâ hukuk danışmanının değerlendirmesine bağlıdır. Önceki durum:
YAYINDA DEĞİL. Karar 0062 (`GEMINI_REALTIME_ENABLED`) üretimde
açılmadan önce hukuk danışmanının değerlendirmesine sunulacak. Bu dosya
hukuki sonuç içermez; değişen teknik olguları ve önerilen metni listeler.

## Değişen teknik olgular

| Konu | Bugün (onaylı, 0059) | Anlık yorum açıkken (0062) |
| --- | --- | --- |
| Zamanlama | Ayrı toplu iş; arama sırasında çağrı yok | Arama isteği içinde, en fazla 2,5 sn |
| Hangi ifadeler | 30 günde ≥3 arama ve ≥3 farklı gün | Tekrar eşiği yok; ilk kez yazılan ifade de gidebilir |
| Süzgeç | Kişisel veri, sır, özel nitelikli veri, uzunluk | Aynı süzgeç (değişmedi) |
| Gönderilen veri | Normalize arama ifadesi + sabit taksonomi | Aynı |
| Kimlik/IP/oturum | Gönderilmez | Gönderilmez |
| `store: false` | Evet | Evet |
| Saklama | Yorum 90 gün | Aynı tablo, aynı 90 gün |
| Hacim sınırı | Günde 100 deneme | Ayrıca günde 2.000 anlık deneme |

Etki: tekrar eşiği LIA'da veri minimizasyonu tedbiri olarak anılıyordu; anlık
yolda kalkıyor. Tek seferlik sorgularda kişisel veri bulunma olasılığı daha
yüksektir (süzgeç sınırları LIA'da belirtilmişti).

## Önerilen metin değişiklikleri (taslak)

- `/gizlilik` §2.2, "Yapay zekâ destekli kategori yorumu": "Bu işlem arama
  yaptığınız anda değil, ayrı bir toplu işlemle yapılır" yerine: "Arama
  ifadeniz, sonuçları iyileştirmek için arama sırasında da bu sağlayıcıya
  gönderilebilir; daha önce yorumlanmış ifadeler için yeniden gönderim
  yapılmaz." "Belirli bir sıklık ve farklı-gün eşiğini aşan" ifadesi kaldırılır.
- `/kvkk-aydinlatma` §5: anlam değişmez; zamanlama ifadesi eklenmez.
- LIA `docs/legal-review/gemini-mesru-menfaat-degerlendirmesi.md`: gereklilik
  testindeki "Arama sırasında Gemini çağrılmaz" ve tekrar eşiği maddeleri
  güncellenir; denge testine anlık yol eklenir.

## Avukata sorular

1. Tekrar eşiği kaldırıldığında m.5/2-f meşru menfaat dengesi korunuyor mu?
2. Mevcut KVKK m.9 aktarım sözleşmesi anlık aktarımı da kapsıyor mu?
3. Aydınlatma metninde zamanlama değişikliği yeterli mi, ek tedbir gerekir mi?
