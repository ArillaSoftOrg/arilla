# PostgreSQL 16 + pgvector + pgBackRest (karar 0110). Uretim `postgres` servisi ve
# `backup` yan konteyneri AYNI imaji kullanir: pgBackRest iki uçta da ayni surum olmalidir
# (TLS repo-host protokolu surum eslesmesi ister).
#
# Taban, uretimde calisan imajla ayni surume ve DIGEST'e sabitlenir (PostgreSQL 16 + pgvector 0.8.1).
# Guvenlik guncellemeleri (apt upgrade) PostgreSQL'i ayni ana surumde MINOR olarak yukseltir
# (orn. 16.12 -> 16.15; veri bicimi ayni). Yeni ikili, aktivasyondaki yeniden baslatmada devreye girer.
# pgBackRest PGDG deposundan (tabanda zaten tanimli ve imzali: bookworm-pgdg main) kurulur.
FROM pgvector/pgvector:0.8.1-pg16@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337

RUN set -eux; \
    apt-get update; \
    apt-get -y upgrade --no-install-recommends; \
    apt-get install -y --no-install-recommends pgbackrest ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    # Paketle gelen ornek yapilandirma kullanilmaz; yapilandirma calisma aninda
    # /etc/arilla-backup (salt-okunur baglama) altindan PGBACKREST_CONFIG ile verilir.
    rm -f /etc/pgbackrest.conf; \
    rm -rf /etc/pgbackrest; \
    install -d -o postgres -g postgres -m 0750 /var/log/pgbackrest /var/spool/pgbackrest /var/lib/pgbackrest; \
    # gosu yalniz root ile baslatmada kullanilir (entrypoint root ise postgres'e duser). Bu imaj root
    # OLMADAN calisir (asagida USER): gosu hic cagrilmaz. Eski Go stdlib'li ikili (Trivy HIGH/CRITICAL)
    # kaldirilir; konteyner root ile baslatilirsa entrypoint acikca hata verir.
    rm -f /usr/local/bin/gosu; \
    pgbackrest version

LABEL org.opencontainers.image.title="arilla-postgres" \
      org.opencontainers.image.description="PostgreSQL 16 + pgvector 0.8.1 + pgBackRest (karar 0110)"

# Root OLMADAN calisir (uid 999 = postgres). Resmi entrypoint, veri dizini bu kullaniciya ait
# oldugunda dogrudan postgres'i baslatir (gosu/chown gerekmez). Uretim veri dizini zaten 999'a aittir.
USER postgres
