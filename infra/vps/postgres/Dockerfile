# PostgreSQL 16 + pgvector + pgBackRest (karar 0110). Uretim `postgres` servisi ve
# `backup` yan konteyneri AYNI imaji kullanir: pgBackRest iki uçta da ayni surum olmalidir
# (TLS repo-host protokolu surum eslesmesi ister).
#
# Taban, uretimde calisan imajla ayni surum ve DIGEST'e sabitlenir; boylece aktivasyonda
# PostgreSQL ikili dosyalari degismez, yalniz pgBackRest eklenir.
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
    pgbackrest version

LABEL org.opencontainers.image.title="arilla-postgres" \
      org.opencontainers.image.description="PostgreSQL 16 + pgvector 0.8.1 + pgBackRest (karar 0110)"

# Root OLMADAN calisir (uid 999 = postgres). Resmi entrypoint, veri dizini bu kullaniciya ait
# oldugunda dogrudan postgres'i baslatir (gosu/chown gerekmez). Uretim veri dizini zaten 999'a aittir.
USER postgres
