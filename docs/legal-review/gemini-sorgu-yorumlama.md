# Hukuki İnceleme Dosyası — Gemini ile Arama Sorgusu Yorumlama

**Ürün:** ManiCepte (Arilla) · **Hazırlanma:** 6 Ekim 2026 · **Son güncelleme:** 6 Ekim 2026
**Kaynaklar:** `docs/kvkk.md` ("Sorgu yorumlama (Google Gemini)"), `docs/decisions/0059-gemini-sorgu-yorumlama.md`,
`docs/legal-review/gemini-mesru-menfaat-degerlendirmesi.md`

1–6. bölümler kodla doğrulanmış teknik olgulardır. 7–9. bölümler hukuki
değerlendirmenin sonucunu kaydeder; sözleşme metni ve gizli koşullar bu
belgede yer almaz.

---

## Teknik olgular

### 1. Google Gemini'ye gönderilen veri

Çevrimdışı bir toplu iş, aşağıdakileri Google'ın Gemini API'sine (model
`gemini-3.1-flash-lite`, uç nokta `https://generativelanguage.googleapis.com/v1/interactions`)
gönderir:

- **Normalize edilmiş arama ifadesi:** kullanıcıların arama kutusuna yazdığı
  metnin küçük harfe çevrilmiş ve boşlukları düzeltilmiş hâli (örn.
  "motor sürerken kafa koruyucu"). Kaynak, ManiCepte'nin mevcut günlük toplu
  arama özetidir (`search_query_day`).
- **Sabit ürün kategorisi listesi:** ManiCepte'nin kendi kategori/filtre
  seçenekleri (örn. "kask türü: kapalı/açık"). Kişisel veri değildir.
- **Sabit talimat metni:** modelin yalnızca bu listeden seçim yapmasını
  isteyen, kişisel veri içermeyen sabit bir metin.

Gönderim **istek anında değil**, ayrı ve elle tetiklenen bir toplu işle
yapılır. Kullanıcı arama yaparken Gemini çağrılmaz. *(7 Ekim 2026: anlık yol, karar
0062, bayrakla açıldığında arama sırasında da çağrılabilir; bkz.
`gemini-anlik-yorum-taslak.md`.)*

### 2. Gönderilmeyen veri

Gemini'ye **hiçbir zaman** gönderilmez: kullanıcı kimliği, hesap, e-posta,
telefon, oturum kimliği, IP adresi, çerez, cihaz bilgisi, konum, kullanıcı
etkinlik kayıtları (`user_activity_event`), arama geçmişi, kaydedilen ürünler,
yüklenen görseller. Gönderilen metin bir kullanıcı hesabıyla ilişkilendirilmez.

**Önemli:** gönderilen metin **anonim değildir; anonimlik garanti edilmez.**
Kullanıcının yazdığı serbest metin, tek başına bir kişiyi belirleyebilecek
bilgi içerebilir.

### 3. Aktarım öncesi süzgeçler ve güvenceler

Bir arama ifadesi ancak **hepsi** sağlanırsa gönderilebilir:

- Son 30 gün içinde **en az 3 kez** ve **en az 3 farklı günde** aranmış olmak.
  (3 farklı gün bir tekrar sinyalidir; 3 farklı kişi olduğunun kanıtı
  **değildir** — aynı kişi üç farklı günde arayabilir.)
- 2–120 karakter uzunluğunda olmak.
- Otomatik (deterministik, yapay zekâ kullanmayan) süzgeçten geçmek. Elenenler:
  e-posta, telefon, adres, internet adresi (URL), uzun rakam dizileri ve kimlik
  numarası benzeri ifadeler, şifre/anahtar benzeri ifadeler.
- **Özel nitelikli kişisel veri (KVKK m.6) çağrıştıran** ifadeler elenir:
  sağlık/hastalık, gebelik, engellilik/inkontinans, din/mezhep kimliği,
  siyasi bağlılık, cinsel hayat/yönelim, genetik/biyometrik, ceza mahkûmiyeti,
  sendika üyeliği.
- Kural tabanlı mevcut arama motoru sorguyu zaten anlıyorsa gönderilmez.

**Sınırlar (bilinen):** süzgeçler riski azaltır, **tüm kişisel veya özel
nitelikli verinin ayıklandığını garanti edemez.** Dolaylı anlatım, yazım
hataları ve listede olmayan terimler geçebilir. Irk/etnik köken, yüksek yanlış
pozitif riski nedeniyle listede yoktur. Süzgeç bilerek temkinlidir: şüpheli
bir ifade gönderilmez (örn. "hamile pantolonu" da gönderilmez).

### 4. Google'ın döndürdüğü ve ManiCepte'nin sakladığı veri

- Google, ifadenin sabit kategori listesindeki karşılığını döndürür (örn.
  "kask / kapalı tip"). Yanıt, ManiCepte tarafında katı bir kurala göre
  doğrulanır; listede olmayan değerler ve metinde yazmayan fiyatlar reddedilir.
- **Saklanan (`query_interpretation`):** normalize arama ifadesi, doğrulanmış
  kategori/filtre kimlikleri, durum kodu, kategori listesi sürüm özeti, model
  sürümü, oluşturulma zamanı.
- **Saklanmayan:** modelin ham yanıtı, gönderilen tam istek, kullanıcı/oturum/IP.
- **Kullanım kaydı (`api_usage`):** her çağrı için işlem türü, model adı ve
  token sayısı; kullanıcı ve oturum alanları boş, sorgu metni yok.
- **İş kaydı (`job_run`):** yalnızca sayılar ve sabit kodlar.
- Saklanan yorum, arama sırasında **yalnızca okunur** ve en düşük öncelikli
  ipucudur; kullanıcının açık seçimleri ve kural tabanlı sonuçlar her zaman
  önceliklidir.

### 5. Saklama süreleri

| Veri | Yer | Süre |
| --- | --- | --- |
| Günlük toplu arama özeti (kaynak) | ManiCepte, `search_query_day` | 90 gün (mevcut) |
| Yapay zekâ yorumu | ManiCepte, `query_interpretation` | **90 gün** (`created_at`'ten), günlük temizlik işiyle silinir |
| Kullanım kaydı | ManiCepte, `api_usage` | Kullanıcı bağlantısı yok; mevcut maliyet kaydı politikası |
| Etkileşim durumu | Google | Saklanmaz (`store: false`, bkz. 6) |
| Kötüye kullanım kayıtları | Google | Google koşullarına göre "sınırlı bir süre"; süre Google tarafından belirtilmemiş |

### 6. `store: false` ve teknik güvenceler

- `store: false`: Google'ın Interactions API'sindeki etkileşim durumu
  saklamasını kapatır (Google belgesine göre varsayılan açıktır; ücretli
  katmanda 55 gün). **Bu, işlemeyi ya da Google'a aktarımı ortadan
  kaldırmaz.**
- Google "Paid Services" (ücretli hizmet) koşullarına göre Google, istem ve
  yanıtları ürünlerini geliştirmek için kullanmaz; ancak Yasaklı Kullanım
  Politikası ihlallerini tespit için **sınırlı bir süre kayıt tutar**. Google
  koşullarına göre veriler, Google'ın tesislerinin bulunduğu ülkelerde geçici
  olarak işlenebilir veya önbelleğe alınabilir.
- Ücretli hizmetler için Google, "Data Processing Addendum for Products Where
  Google is a Data Processor" kapsamındadır (aktarım araçları AB/BK/İsviçre
  standart sözleşme hükümleri vb.; Türkiye/KVKK anılmaz).
- API anahtarı yalnızca sunucuda tutulur, tarayıcıya gönderilmez.
- Maliyet/kötüye kullanım sınırları: çalıştırma başına en fazla 20 ifade,
  gün başına en fazla 100 sağlayıcı çağrısı, 10 sn zaman aşımı.
- Bağlantı testi yalnızca sabit, sentetik bir ifadeyle yapılmıştır
  ("motor sürerken kafa koruyucu"); gerçek kullanıcı verisi gönderilmemiştir.

### 7. Etkinleştirme durumu

- Hukuk danışmanı üretimde etkinleştirmeyi onaylamıştır (bkz. 8).
- İşleme, Gemini API anahtarı üretime (Vercel) bilinçli olarak eklendiğinde
  başlar. Anahtar eklenene kadar toplu iş hiçbir şey göndermez. Toplu iş
  günde bir kez (00:30 UTC) Vercel cron ile çalışır; elle de tetiklenebilir.
  Gün başına en fazla 100 sağlayıcı denemesi.
- Gizlilik politikası (`/gizlilik`) ve KVKK aydınlatma metni
  (`/kvkk-aydinlatma`) bu işlemeyi 6 Ekim 2026 tarihli metinle açıklar; metin
  yayına alınmadan anahtar eklenmez.
- Etkinleştirme sırası: `docs/ops.md` "Etkinleştirme sırası".

### 8. Hukuki karar kaydı

- **İşleme şartı:** KVKK m.5/2-f meşru menfaat. Meşru menfaat değerlendirmesi
  (amaç, gereklilik, denge testi): `docs/legal-review/gemini-mesru-menfaat-degerlendirmesi.md`.
- **Açık rıza:** Bu akış açık rızaya dayanmaz; hukuki sebep meşru menfaattir.
- **Yurt dışı aktarım (KVKK m.9):** Gerekli aktarım sözleşmesi Google ile
  imzalanmıştır. Google'ın DPA'sı tek başına bunun yerine geçmez.
- **Sözleşme tarafı, imza tarihi ve onay:** Hukuki / sözleşme kaydında tutulur;
  kamuya açık metinler sağlayıcıyı "Google (Gemini API)" olarak anar.
- **Kurum bildirimi ve VERBİS:** Tamamlandığına dair bu depoda kayıt yoktur;
  durum hukuki kayıtta izlenir (`docs/kvkk.md` "Etkinleştirme kontrol listesi").
- **Kamuya açık metin:** `/gizlilik` §2.2, §3, §4, §5, §6, §8 ve
  `/kvkk-aydinlatma` §3, §4, §5. Gönderilen veri "kullanıcı kimliği, IP ve
  oturum bilgilerinden arındırılmış, deterministik süzgeçlerden geçirilerek
  normalleştirilmiş arama ifadeleri" olarak tanımlanır ve anonim olarak
  nitelendirilmez.

### 9. Gözden geçirme

Gönderilen veri, süzgeçler, eşikler, sağlayıcı, model ya da işleme amacı
değişirse bu dosya ve meşru menfaat değerlendirmesi yeniden incelenir ve
gerekirse hukuk danışmanına sunulur.

---

**Google kaynakları:** [Gemini API koşulları](https://ai.google.dev/gemini-api/terms) ·
[Veri İşleme Eki (DPA)](https://business.safety.google/processorterms/) ·
[DPA kapsamındaki hizmetler](https://business.safety.google/services/) ·
[Interactions API / `store`](https://ai.google.dev/gemini-api/docs/interactions)
