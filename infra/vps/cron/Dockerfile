# Zamanlayici imaji (karar 0109): Vercel cron'larinin ve GitHub Actions
# (kaldirilan) `trigger-alerts-cron.yml`'in yerine, VPS'te web'in /api/cron/* uclarini ic
# agdan cagirir. Yalnizca HTTP + CRON_SECRET; veritabani kimligi YOKTUR.
#
# supercronic kaynaktan, GUNCEL Go ile derlenir (go.sum/sumdb dogrulamali): hazir
# release ikilisi eski Go standart kutuphanesi tasir ve Trivy HIGH raporlar.
FROM golang:1.26-alpine AS supercronic
ARG SUPERCRONIC_VERSION=v0.2.49
RUN CGO_ENABLED=0 GOBIN=/out go install -trimpath -ldflags="-s -w" \
    "github.com/aptible/supercronic@${SUPERCRONIC_VERSION}"

# 3.23: 3.21'in destegi Kasim 2026'da biter; 3.21'deki curl 8.14.1-r2 Trivy'de 10 HIGH verdi.
FROM alpine:3.23

# Taban imajdan sonra yayinlanan guvenlik yamalari derleme aninda alinir. DIKKAT: CI bu
# katmani GHA onbelleginden (scope=cron) yeniden kullanir; yeni yama ancak bu katman ya da
# taban imaj degisince gelir. Trivy yamasi cikmis HIGH bulursa taban surumunu yukselt.
RUN apk upgrade --no-cache \
    && apk add --no-cache curl ca-certificates tzdata \
    && adduser -S -u 10001 -H arilla

COPY --from=supercronic /out/supercronic /usr/local/bin/supercronic
COPY crontab /etc/arilla/crontab
COPY cron-call.sh /usr/local/bin/cron-call
RUN chmod 0755 /usr/local/bin/cron-call

USER arilla
ENV TZ=UTC
# Ayni is bir onceki kosu bitmeden yeniden baslatilmaz (supercronic varsayilani).
CMD ["supercronic", "/etc/arilla/crontab"]
