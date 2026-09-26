# 0039 — Yönetim konsolu, yetki haritası ve denetim kaydı

**Tarih:** 26 Eylül 2026
**Durum:** Kabul edildi

## Karar

1. **Tek iç uygulama: `/yonetim`.** Ortak `layout.tsx`, yan menü ve genel
   bakış sayfası. Var olan `/yonetim/eslestirme` ve `/yonetim/sozluk`
   adresleri ve klavye kısayolları değişmez; kabuğun içine alınır. Yeni
   modüller aynı kabuğa eklenir, ayrı panel kurulmaz.
2. **Rol sistemi değişmez, üstüne sabit bir yetki haritası gelir.**
   `app_user.role` tek kaynaktır. `packages/core/src/admin/capabilities.ts`
   rolü yeteneklere eşler (`matching.review`, `dictionary.write`,
   `audit.read`, ...). Roller tablosu yok, arayüzden rol atama yok; rol
   yükseltme yalnızca elle SQL ile yapılır.
3. **İki savunma hattı.** `apps/web/app/lib/dal.ts` `requireCapability` her
   sayfada ve server action'da çağrılır. Core mutasyonları ayrıca
   `assertCapability` ile kendi içinde denetler: yarın `apps/api` ya da
   `apps/mcp` aynı fonksiyonu çağırırsa web kontrolünü atlayamaz. Menüde
   bir bağlantının gizlenmesi yetki değildir.
4. **Oturum var ama yetki yoksa 404.** Anonim ziyaretçi `/giris`'e gider;
   girişli ama yetkisiz kullanıcı `notFound()` görür — yönetim alanının
   varlığı doğrulanmaz.
5. **`admin_audit_event` (migration 0027), append-only.** Her yönetim
   mutasyonu, mutasyonla AYNI işlemde bir satır yazar: aktör, işlem anındaki
   rol, eylem, hedef, izin verilen alanlarla önce/sonra. Kayıt yazılamazsa
   değişiklik geri alınır. `arilla_app` yalnızca SELECT + INSERT;
   `pnpm db:verify` bunu her koşuda kanıtlar. Parola, token, çerez, IP,
   user agent yazılmaz. Okuma yalnızca `audit.read` (admin).
6. **Denetim ≠ işletim ≠ analitik ≠ hata.** Bu tablo yalnızca güvenlik ve
   denetim olaylarıdır. Koşu geçmişi `ingest_run`'da kalır; genel bir
   `logs` tablosu kurulmaz.
7. **Genel bakış yalnızca gerçek veri gösterir.** Arama günlüğü
   tutulmadığı için arama sayısı ve sıfır sonuç oranı yoktur; boşluk yer
   tutucu sayıyla doldurulmaz.
8. **Eşleştirme onayı var olan bağı ezmez.** Teklif bu arada başka bir
   ürüne bağlandıysa onay `conflict` döner ve hiçbir şey değişmez. Onayda
   aynı teklifin diğer bekleyen adayları reddedilir; `reviewed_by` artık
   yazılır.

## Gerekçe

Konsol büyüyecek (merchant, koşu geçmişi, tanılama), ama bugün iki rol ve
bir iki personel var. Rol tablosu ve dinamik RBAC bu ölçekte bakım yükü
getirir, güvenlik kazancı getirmez. Sabit harita birim testle
doğrulanabilir; rol eklemek tek dosyalık değişikliktir.

Denetim kaydı olmadan “bu eşleştirmeyi kim onayladı” sorusu cevapsızdı:
`match_candidate.reviewed_by` kolonu vardı ama hiç yazılmıyordu. Kaydı
uygulama rolünün değiştirememesi, kaydı silebilen bir hatanın ya da
saldırganın izini de silememesi içindir.

## Reddedilen alternatifler

- **Rol/yetki tabloları, `super_admin`, `support` rolü.** İhtiyaç doğunca.
- **Hazır admin çatısı (react-admin, Refine) ya da ikinci bir tasarım
  sistemi.** `@arilla/ui` ve belirteçler yeterli; üçüncü taraf CDN yasağı.
- **Genel tablo düzenleyici.** Her mutasyon amaca özel core fonksiyonudur.
- **Kullanıcıyı taklit etme (impersonation).** KVKK ve güven riski,
  gerekçesi yok.
