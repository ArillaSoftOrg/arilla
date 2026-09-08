# Yerel gelistirme

```bash
cd infra
docker compose up -d
```

| Servis | Adres | Not |
| --- | --- | --- |
| Postgres | `localhost:5432` | pgvector dahil imaj |
| Redis | `localhost:6379` | cache ve kuyruk |
| MinIO | `localhost:9000`, panel `:9001` | S3 uyumlu, uretimde R2/S3 |
| Mailpit | SMTP `:1025`, panel `localhost:8025` | Giris baglantilari buraya duser |

Mailpit onemli: gelistirme sirasinda giris e-postalari disari cikmaz, hepsi
panelde gorunur. Gercek adreslere test maili gonderip alan adinin itibarini
zedelemek boylece engellenir.

Uretimde web Vercel'de, Python worker ayri bir barindirmada calisir —
Vercel uzun suren arka plan islerini desteklemiyor. Bkz. `docs/ops.md`.
