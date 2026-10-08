# Python toplu isleri icin tek imaj. Varsayilan komut link worker'idir
# (queue:link_resolution tuketicisi); ayni imaj `docker run ... python -m
# enrich ...` gibi elle isler icin de kullanilabilir. Bkz. docs/ops.md
# "Link worker". Gizli deger imaja girmez: ortam degiskenleri calisma aninda
# verilir (.dockerignore .env'i disarida birakir).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app/services/ingest

# Once yalnizca bagimlilik tanimi: kaynak degisince katman yeniden kurulmaz.
COPY pyproject.toml ./
RUN python -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml','rb'))['project']['dependencies']))" > /tmp/requirements.txt \
    && pip install -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY . .

RUN useradd --system --no-create-home --uid 10001 arilla
USER arilla

# SIGTERM worker'da yakalanir (collect/link/__main__.py): acik islem geri
# alinir, baglanti kapanir. Kopan veritabani baglantisinda surec 1 ile cikar;
# yeniden baslatma surec yoneticisinin (compose `restart`) isidir.
CMD ["python", "-m", "collect.link", "--worker"]

# Worker HTTP endpoint SUNMAZ: saglik, kuyruk dongusunun yazdigi heartbeat
# dosyasinin tazeligidir (WORKER_HEARTBEAT_FILE, varsayilan
# /tmp/link-worker.heartbeat). Redis'e ulasilamazsa dosya yenilenmez.
HEALTHCHECK --interval=60s --timeout=15s --start-period=90s --retries=3 \
    CMD ["python", "-m", "collect.link", "--healthcheck"]
