# Meşru Menfaat Değerlendirmesi (LIA) — Gemini ile Arama Sorgusu Yorumlama

**Veri sorumlusu:** Arilla (ManiCepte) · **Hukuki sebep:** KVKK m.5/2-f (meşru menfaat)
**Durum:** Hukuk danışmanı yaklaşımı onayladı. Bu belge onaylanan yaklaşımın
kaydıdır; sözleşme metni içermez.
**Teknik kaynak:** `docs/decisions/0059-gemini-sorgu-yorumlama.md`, `docs/kvkk.md`

## 1. Amaç testi

- **Menfaat:** Kullanıcıların serbest metinle yaptığı aramaların doğru ürün
  kategorisine ve filtreye eşleştirilmesi; kural tabanlı arama motorunun
  anlayamadığı, sık tekrarlanan ifadeler için daha isabetli sonuç.
- **Meşruiyet:** Hizmetin temel işlevinin (arama ve karşılaştırma) kalitesini
  artırır; kullanıcıların da beklediği bir sonuçtur.
- **Kapsam dışı:** Profil çıkarma, kişiye özel öneri, pazarlama, reklam,
  davranış takibi. Yorum kişiye değil, arama ifadesine bağlıdır.

## 2. Gereklilik testi

- Kural tabanlı arama, kategori sözlüğünün kapsamadığı ifadeleri
  yorumlayamaz; sözlük her ifadeyi elle karşılayamaz.
- **Asgari veri:** Yalnızca normalize edilmiş arama ifadesi gönderilir;
  kullanıcı kimliği, IP, oturum, cihaz, konum, etkinlik kaydı gönderilmez.
- **Yalnızca gerekli ifadeler:** Son 30 günde en az 3 kez ve en az 3 farklı
  günde aranmış, kural tabanlı aramanın zaten anladığı ifadeler hariç. Koşu
  başına en fazla 20 ifade, günde en fazla 100 sağlayıcı çağrısı.
- **Daha az müdahaleci alternatif:** Her aramada canlı model çağrısı
  reddedildi; yorum bir kez üretilir, saklanır ve yeniden kullanılır. Arama
  sırasında (istek yolunda) Gemini çağrılmaz.

## 3. Denge testi

**Kullanıcı açısından riskler**
- Serbest metin kişisel veri içerebilir; gönderilen ifadeler **anonim kabul
  edilmez ve anonimlik garanti edilmez.**
- Veri yurt dışında işlenir (Google).
- Süzgeçler her kişisel veriyi yakalayamayabilir.

**Alınan tedbirler**
- Deterministik süzgeç: e-posta, telefon, adres, URL, kimlik numarası ve uzun
  rakam dizileri, şifre/anahtar benzeri ifadeler elenir.
- Özel nitelikli veri (KVKK m.6) bağlamı elenir: sağlık, gebelik,
  engellilik/inkontinans, din/mezhep kimliği, siyasi bağlılık, cinsel
  hayat/yönelim, genetik/biyometrik, ceza mahkûmiyeti, sendika.
- Gönderilen ifade hiçbir kullanıcı hesabıyla ilişkilendirilmez.
- Sağlayıcıdan dönen ham yanıt saklanmaz; yalnızca doğrulanmış kategori
  kimlikleri saklanır.
- `store: false`: Google tarafında etkileşim durumu saklanmaz. (Google, ücretli
  hizmet koşulları gereği içeriği ürün geliştirmede kullanmaz; ancak güvenlik ve
  kötüye kullanım tespiti için sınırlı süre kayıt tutabilir.)
- Yurt dışı aktarım: KVKK m.9 kapsamında Google ile imzalanan aktarım sözleşmesi.
- Saklanan yorum aramada **en düşük öncelikli** ipucudur; kullanıcının açık
  seçimi ve kural tabanlı sonuç her zaman önceliklidir. Yorum kullanıcı
  hakkında karar üretmez.
- Kullanıcıya açık uyarı: aydınlatma metninde arama kutusuna kişisel veya
  hassas bilgi yazılmaması istenir.

**Süzgeç sınırları (açıkça kabul edilen)**
- Dolaylı anlatım, yazım hataları ve listede olmayan terimler süzgeçten
  geçebilir. Irk/etnik köken, yüksek yanlış pozitif riski nedeniyle listede
  yoktur.
- 3 farklı gün bir tekrar sinyalidir, 3 farklı kişinin kanıtı değildir.

**Sonuç (onaylanan yaklaşım):** Risk; asgari veri, süzgeçler, kimlik
ayrımı, sınırlı saklama, yurt dışı aktarım güvencesi ve aydınlatma ile makul
düzeye indirilmiştir. Hukuk danışmanı bu yaklaşımı onaylamıştır.

## 4. Saklama

- Yapay zekâ yorumu (`query_interpretation`): en fazla **90 gün**; günlük
  temizlik işiyle otomatik silinir.
- Kaynak toplu arama özeti (`search_query_day`): 90 gün (mevcut).
- Kullanım kaydı (`api_usage`): kullanıcı bağlantısı ve sorgu metni yok.

## 5. Gözden geçirme

Süzgeç listesi, eşikler, sağlayıcı ya da işleme amacı değişirse bu
değerlendirme yeniden yapılır. Açık kayıtlar: `docs/kvkk.md`
"Etkinleştirme öncesi hukuki kontrol listesi" ([CONFIRM] alanları).
