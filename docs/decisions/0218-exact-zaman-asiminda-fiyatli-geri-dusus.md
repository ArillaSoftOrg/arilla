# 0218 — Exact sorgu zaman aşımında fiyatlı ürünlerle geri düşüş

## Sorun

Üretimde `statement_timeout` (5 sn) aşılan exact sorgular hata sayfasına düşüyordu. 0215 iki slotlu
"kablosuz kulaklık" gibi sorguları düzeltti; kalanlar: üç slotlu ("kadın omuz çantası", "dikey süpürge
hafif") ve çok yaygın baş isimli ("erkek spor ayakkabı", "çelik tencere seti") sorgular.

Üretimde salt okunur `EXPLAIN (ANALYZE)` ile ölçüldü ("kadın omuz çantası", toplam 14,9 sn):
- Fiyatlı bölüm (`offer_count > 0`) dalları toplam <20 ms.
- Süre yurt dışı bölümünde (`offer_count = 0`): tek dal 9,5 sn. "women" gibi bir alternatif 1,97 milyon satır
  döndürüyor, bitmap kayıplı (lossy) oluyor, 159 bin satır yeniden denetleniyor; diğer slot satır süzgeci.
- 3 slotlu "bir eksik" dallarını 2 slotlu `crossAnd` ile dağıtmak denendi: 132 dal, 14,9 → 12,6 sn. Yetmedi,
  reddedildi.

## Karar

Exact adımı zaman aşımına uğrarsa sağlayıcı (`postgres-provider.ts`) hata fırlatmak yerine aynı sorguyu
yalnızca fiyatlı bölümle (`candidate_scope: "priced"`, `candidateCtes` `pricedOnly`) en çok 2 sn sınırıyla
yeniden dener ve `partial: true` döndürür. Pipeline bunu `trace.truncated = true` ve `totalCapped = true` yapar.

Ölçüm (üretim, salt okunur, aday kümesi): "kadın omuz çantası" 13,7 ms, "erkek spor ayakkabı" 51 ms,
"çelik tencere seti" 6,8 ms.

Kapsam: yalnızca zaman aşımı sonrası; bulanik (`fuzzy`), bütçeli (`budgetMs`) ve metinsiz sorgular kendi
yolunda kalır. Zaman aşımı olmayan sorguların sonucu DEĞİŞMEZ.

## Sınır / bilinen eksik

- Sonuç eksik kümedir: yurt dışı (fiyatsız) ürünler yok. Gösterilen ilk sayfa fiyatlı ürünlerdir; toplam alt sınırdır.
- Bu durumda kullanıcıya "eksik" notu henüz gösterilmiyor (`trace.truncated` yalnız boş durumda arayüze bağlı).
- Toplam bekleme en kötü 5 + 2 sn; yaygın sorgular için asıl çözüm (yurt dışı bölümü için ayrı bir önkoşul ya da
  önceden hesaplanmış seçicilik) ayrı iştir.

## Reddedilen alternatifler

- 3 slotlu "bir eksik" dallarını dağıtmak (yukarıda, 12,6 sn).
- Yurt dışı bölümünü her zaman atlamak: sonuç kümesini sessizce değiştirir.
- İlk denemenin süresini kısaltmak: yavaş ama tam sonucu olan sorguları keser.
