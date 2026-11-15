# 0210 — IntentV2: en fazla 3 doğrulanmış alternatif arama terimi (yalnız aday bulma)

**Tarih:** 15 Kasım 2026 · **Durum:** kabul edildi, yerelde (birleşmedi) · **İlgili:** 0062, 0171, 0197
· **Bayrak:** `QUERY_INTENT_V2_ALT_TERMS` (varsayılan KAPALI; yalnız `QUERY_INTENT_V2` etkinken anlamlı)

## Sorun

Katalog İngilizce ağırlıklı, sorgular Türkçe. Lexicon eş anlamlıları dar ("kulaklık" var, "bebek bezi"
yok): metin kapısı hiç aday bulamıyor ya da fallback'e düşüyor. E4b C+ deneyi (yazım vektörüyle sıralama,
aralayarak birleştirme) çalışmadı; bu karar sıralamaya DOKUNMAZ.

## Karar

1. **Şema:** IntentV2 çıktısına isteğe bağlı `alternative_terms[{text, lang, for_text}]` (en fazla 3).
   Alan adı dilden bağımsızdır: kaynak dil Türkçe zorunlu, hedef dil serbest (`lang` ISO 639-1 ya da null);
   katalog İngilizce ağırlıklı olduğundan çoğunlukla İngilizce beklenir. `for_text` sorgudan birebir
   kopyalanmış kelime/ifadedir (kanıt).
2. **Aynı çağrı:** ek model çağrısı yok. Alan yalnız bayrak açıkken şemaya/talimata girer ve çıktı
   bütçesi 128 token artar. Ham çıktı `query_interpretation`'a olduğu gibi yazılır (kural 3), `api_usage`
   ve `queryContentIneligibility` süzgeci aynen geçerli.
3. **Sözleşme sürümü:** `schema_version` 2 kalır; alan opsiyoneldir, eski kayıtlar okunur (alan yok = terim
   yok). Bayrak kapalıyken talimat, şema ve `intentV2ContractHash` eskisiyle BİREBİR aynıdır (test pinli).
   Bayrak açıkken özet farklıdır: açıldığında sorgular terimli şemayla yeniden yorumlanır (günlük tavan
   içinde); kapatılınca eski özetli satırlar yeniden okunur.
4. **Doğrulama (model terimi lexicon/süzgeçten geçer):** en fazla 3; 3–40 karakter, en fazla 3 kelime,
   yalnız harf (rakam, sembol, URL, e-posta, kimlik/sır, KVKK m.6 bağlamı reddi, `queryContentIneligibility`);
   orijinal sorguyla ya da birbiriyle aynı olan atılır; lexicon markası ve marka içeren terim atılır; sorgu
   aksesuar/araç istemiyorsa aksesuar kalıbı (`looksLikeAccessory`, `queryWantsAccessory`, `product-title-guard`
   aksesuar kelimeleri) taşıyan terim atılır; `for_text` sorguda birebir yoksa atılır; çekirdek (rol/tür)
   reddedildiyse hiçbiri uygulanmaz.
5. **Uygulama:** yalnız `applyIntentPlan` içinde, `for_text`i alternatifi olarak taşıyan slotun SONUNA eş
   anlamlı olarak eklenir (`text_slots`). Orijinal alternatifler ve slot sırası aynen kalır; `unparsed`, filtreler,
   sıralama, BGE/anlamsal sorgu girdisi değişmez. Kural 1'in IntentV2 istisnası kapsamı genişlemez (aynı çağrı).
   Yalnız `QUERY_INTENT_V2=on` iken uygulanır; `shadow`'da saklanır, uygulanmaz.

## Reddedilen

- Alternatifleri vektöre/sıralamaya katmak (E4b C+ başarısız).
- Ayrı çeviri çağrısı (ek maliyet, kural 1 genişlemesi).
- Çok kelimeli tüm sorgu çevirisi: tek bir slota eşlenemez; AND anlamı bozulur.

## Sınırlar ve bilinenler

- Slot genişlemesi süreyi artırabilir (yerel 160k ürün, ilişkisiz el yazımı terimlerle: toplam +%30,
  en kötü sorgu 3,2 sn → 6,1 sn); terim sayısı ≤3 ile sınırlı. Fallback adım bütçesi (#353) ayrı iştir.
- Lexicon'da zaten olan eşanlamlı (ör. `araba -> car`) yeni etki yaratmaz; bu eşlemenin yanlış pozitifliği
  ayrı bir lexicon sorunudur, aksesuar/araç alanı sorgularında terim süzgeci bilerek gevşektir.
- Terim kalitesi modele bağlıdır; ölçümler el yazımı terimle yapıldı, gerçek model çıktısı DOĞRULANMADI.
- Açma öncesi: gerçek model ile gölge ölçüm (terimsiz/terimli aday sayısı, süre) gerekir.
