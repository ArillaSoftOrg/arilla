# Hukuki İnceleme Dosyası — Gemini ile Arama Sorgusu Yorumlama

**Ürün:** ManiCepte (Arilla) · **Hazırlanma:** 6 Ekim 2026 · **Kod sürümü:** `main` 6cbeb14
**Kaynaklar:** `docs/kvkk.md` ("Sorgu yorumlama (Google Gemini)"), `docs/decisions/0059-gemini-sorgu-yorumlama.md`

Bu belge **hukuki sonuç içermez.** 1–8. bölümler kodla doğrulanmış teknik
olgulardır; 9. bölüm nitelikli Türk hukuk danışmanının cevaplaması gereken
sorulardır.

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
yapılır. Kullanıcı arama yaparken Gemini çağrılmaz.

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

### 7. Gemini neden şu anda devre dışı

- Üretimde (Vercel) Gemini API anahtarı tanımlı değildir; toplu iş anahtar
  olmadan hiçbir şey göndermez.
- Toplu iş zamanlanmamıştır; elle tetiklenmemiştir.
- Canlı gizlilik politikası ve KVKK aydınlatma metni Google/Gemini işlemesini
  henüz içermez — işleme başlamadığı için bu doğrudur.
- Etkinleştirme, bu dosyadaki hukuki kararlara ve `docs/kvkk.md`
  "Etkinleştirme öncesi hukuki kontrol listesi"ne bağlıdır.

### 8. Etkinleştirmeden önce gereken kararlar (özet)

KVKK m.5 işleme şartı; KVKK m.9 yurt dışı aktarım mekanizması (ve gerekiyorsa
standart sözleşme + Kurum bildirimi); sözleşme tarafı Google tüzel kişisi ve
koşul/DPA kayıtları; VERBİS güncellemesi; açık rıza gerekip gerekmediği;
`/gizlilik` ve `/kvkk-aydinlatma` nihai metinleri. Bu kararlar alınıp metinler
yayına girmeden anahtar üretime eklenmeyecektir.

---

## 9. Avukatın cevaplaması gereken sorular

1. **Kişisel veri niteliği:** Kullanıcı hesabıyla ilişkilendirilmeyen, eşik ve
   süzgeçten geçmiş normalize arama ifadeleri bu bağlamda kişisel veri sayılır
   mı? Sayılırsa hangi hâllerde?
2. **KVKK m.5 hukuki sebep:** Bu işleme için hangi şart esas alınmalıdır?
3. **Meşru menfaat:** m.5/2-f (meşru menfaat) kullanılabilir mi? Kullanılacaksa
   yazılı bir menfaat dengesi testi hazırlanmalı mı, içeriği ne olmalı?
4. **Açık rıza:** Bu akış için açık rıza zorunlu mu? (Teknik not: mevcut
   tasarımda bu akışa bağlı bir rıza mekanizması yoktur; gerekirse ayrı bir
   geliştirme gerekir.)
5. **KVKK m.9 yurt dışı aktarım:** Hangi aktarım mekanizması uygulanmalı
   (yeterlilik kararı, uygun güvenceler, istisnalar)? Tekrarlayan bir toplu
   aktarımda açık rızaya dayanılabilir mi?
6. **Standart sözleşme ve bildirim:** KVKK standart sözleşmesi gerekli mi?
   Gerekliyse Google ile imzalanabilir mi ve Kurum'a bildirim (süre ve içerik)
   nasıl yapılmalı? Google'ın DPA'sı (AB SCC'leri) bu amaçla yeterli mi?
7. **Sözleşme tarafı ve işleyen beyanı:** Gemini API ücretli hizmetinde
   sözleşme tarafı Google tüzel kişisi hangisidir; aydınlatma metninde alıcı
   olarak nasıl anılmalıdır? Hangi belgeler saklanmalıdır (koşullar, DPA
   sürümü, kabul tarihi, alt işleyen listesi)?
8. **Özel nitelikli veri:** Deterministik süzgeç (bkz. 3) yeterli bir güvence
   mi; ek tedbir veya farklı bir hukuki sebep gerekir mi?
9. **VERBİS:** Alıcı grupları ve yurt dışı aktarım bilgisi için VERBİS kaydı
   güncellenmeli mi; nasıl?
10. **Nihai metin:** `/gizlilik` (§2.2 arama bilgileri, §5 paylaşım, §6 yurt
    dışı aktarım, §8 saklama) ve `/kvkk-aydinlatma` (§3 amaçlar, §4 hukuki
    sebep, §5 aktarım) için kesin metin nedir? Taslak metin `docs/kvkk.md`
    "Önerilen metin — YAYINDA DEĞİL" bölümündedir.

---

**Google kaynakları:** [Gemini API koşulları](https://ai.google.dev/gemini-api/terms) ·
[Veri İşleme Eki (DPA)](https://business.safety.google/processorterms/) ·
[DPA kapsamındaki hizmetler](https://business.safety.google/services/) ·
[Interactions API / `store`](https://ai.google.dev/gemini-api/docs/interactions)
