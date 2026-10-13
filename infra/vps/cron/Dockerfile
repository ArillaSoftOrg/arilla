# Zamanlayici imaji (karar 0109): Vercel cron'larinin ve GitHub Actions
# `trigger-alerts-cron.yml`'in yerine, VPS'te web'in /api/cron/* uclarini ic
# agdan cagirir. Yalnizca HTTP + CRON_SECRET; veritabani kimligi YOKTUR.
FROM alpine:3.21

ARG SUPERCRONIC_VERSION=v0.2.49
# GitHub release `digest` alani ile ayni (linux-amd64). Hostinger KVM 4 = amd64.
ARG SUPERCRONIC_SHA256=a53ae236602c7338aba3fbaff40bda6300eae3b9fedb8261eb06cfe3724430c1

RUN apk add --no-cache curl ca-certificates tzdata \
    && [ "$(uname -m)" = "x86_64" ] || { echo "supercronic yalniz amd64 icin sabitlendi" >&2; exit 1; } \
    && curl -fsSL -o /usr/local/bin/supercronic \
       "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
    && echo "${SUPERCRONIC_SHA256}  /usr/local/bin/supercronic" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/supercronic \
    && adduser -S -u 10001 -H arilla

COPY crontab /etc/arilla/crontab
COPY cron-call.sh /usr/local/bin/cron-call
RUN chmod 0755 /usr/local/bin/cron-call

USER arilla
ENV TZ=UTC
# Ayni is bir onceki kosu bitmeden yeniden baslatilmaz (supercronic varsayilani).
CMD ["supercronic", "/etc/arilla/crontab"]
