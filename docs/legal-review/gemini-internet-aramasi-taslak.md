# Gemini internet ürün araması — hukuki değerlendirme taslağı (karar 0102)

**Durum:** TASLAK, onaysız. Onay gelmeden üretimde `WEB_SEARCH_LEGAL_APPROVED` açılmaz.

## Verinin gittiği yer

- Google (Gemini API, Google Search grounding + URL Context). `store: false`.
- Giden: yalnızca süzgeçten geçmiş ürün terimleri (metin sorgusu; link aramasında
  çözümlenmiş ürün başlığı/markası). Giden **değil**: kullanıcı kimliği, e-posta, IP,
  oturum, yüklenen görsel/embedding, yapıştırılan adres.
- Süzgeç: e-posta, telefon, adres, IBAN/kimlik benzeri, anahtar önekleri ve KVKK m.6
  özel nitelikli veri bağlamı içeren sorgu hiç gitmez (`queryContentIneligibility`).

## Karar verilmesi gerekenler

1. Arama sorgusunun (kullanıcı serbest metni) Google'a gönderilmesi için dayanak ve
   aydınlatma metni; mevcut anlık yorum (0062) metniyle birleştirilebilir mi.
2. Link aramasında **üçüncü taraf sayfa başlığının** modele gönderilmesi (0090 sohbet
   akışında bu yasak; burada ürün başlığı sınırlı ve süzgeçli gider).
3. Google Search grounding kullanım şartları: gösterim ve `search_suggestions`
   yükümlülükleri, sonuçlar önbelleklenmez/saklanmaz; öneriler değiştirilmeden gösterilir.
4. Mağaza bağlantıları doğrudan açılır; tıklama kaydı tutulmaz (Google şartları).

## Teknik güvenceler

Bayrak varsayılan kapalı; üretimde çift bayrak; günlük ve kişi başına limit; Redis
kapalıysa model yok; sonuçlar katalog verisi değil, kalıcı saklanmaz.
