# 0122 — CI hızlandırma (güvenlik kapıları korunarak)

## Karar

1. `compose stack` işi ikiye bölündü: `compose stack (production topology)`
   (shellcheck + `smoke-local.sh`) ve `deploy engine (rollback + migration, local)`
   (`test-deploy.sh`). İkisi paralel koşar. İkinci iş imajları
   `BUILD_ONLY=1 smoke-local.sh` ile aynı derleme tanımından üretir; hiçbir test
   çıkarılmadı.
2. `test-deploy.sh` içinde sağlıksız sürüm senaryosunun bekleme süresi CI'da
   `DT_WEB_TIMEOUT=75` olur (varsayılan 150). Üretimdeki `arilla-deploy`
   zaman aşımları (`ARILLA_HEALTH_TIMEOUT_WEB=240`) değişmedi.
3. `ci` ve `security-checks` eşzamanlılığı: PR'da aynı PR'ın eski koşusu iptal
   edilir; main'de koşu commit sha'sına özeldir ve asla iptal edilmez (her main
   commit'i tam sonuç alır, build-push/deploy zinciri bunlara bakar).
4. Yalnızca PR'larda, değişen dosyaların tamamı `docs/**` (`docs/schema.sql`
   hariç; testler okur) veya kök `*.md` ise ağır işler atlanır. Atlanan iş
   zorunlu kontrol olarak başarılı sayılır. main'e push'ta her zaman tam koşu.
5. Web derlemesine `.next/cache` önbelleği eklendi (yalnızca hızlandırıcı).
6. `build-push` kapısı ve `deploy plan` yeni kontrolü şöyle ister: commit'te
   varsa `success` olmalı, yoksa (bu değişiklikten önceki commit) kabul edilir —
   böylece `allow_older` ile eski sürüme bilinçli dönüş bozulmaz.

## Gerekçe

Kritik yol `compose stack` idi (~430 sn; `test-deploy.sh` bölüm 5'te ~200 sn
sağlık zaman aşımı beklemesi). Diğer işler 30–130 sn.

## Reddedilen

- Docker katmanını CI'dan GHCR'a yazan önbellek: yeni yazma yüzeyi, kazanç küçük.
- `build-push` içinde tarama + yayın birleştirme: "hepsi taranmadan hiçbiri
  yayınlanmaz" özelliğini değiştirir; ayrı karar gerekir.
- Docs-only commit'te main'de build-push/deploy atlama: deploy planı manifest
  bekler; üretim hattına dokunmamak için yapılmadı.
- Zorunlu kontrol listesini (ruleset) değiştirmek: gerek yok; yeni iş ruleset'e
  eklenmedi, kapılar build-push/deploy içinde.
