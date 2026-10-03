import { isOfferState, listOffers, type OfferState, waitedText } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { Notice, PageHeader, Pager } from "../../admin-ui.tsx";
import { formatDateOrDash, formatKurus, hrefWith, positiveInt } from "../../format.ts";

const STATE_LABELS: Record<OfferState, string> = {
  unmatched: "Eşleşmemiş (aktif)",
  no_candidate: "Eşleşmemiş, hiç adayı yok",
  rejected_only: "Eşleşmemiş, bütün adayları reddedilmiş",
  invalid_gtin: "Geçersiz barkodlu (aktif)",
  inactive: "Pasif",
  stale: "Bayat (7 gündür görülmedi)",
  all: "Tümü",
};

/**
 * Durumun ne anlama geldiği; `services/ingest/resolve/pipeline.py` kurallarından
 * türetilir (karar 0053). Teklif başına kesin neden UYDURULMAZ: yalnızca
 * kanal girdileri (barkod/MPN, görsel vektörü) gösterilir.
 */
const STATE_NOTES: Partial<Record<OfferState, string>> = {
  no_candidate:
    "Varsayılan eşleştirme koşusu her eşleşmemiş aktif teklife ya aday yazar ya da yeni ürün açıp bağlar. Hiç aday kaydı olmayan teklife koşu henüz ulaşmamıştır: teklif son koşudan sonra gelmiş, koşu kotası (500 teklif, kimlik sırasıyla) dolmuş, koşu yeni ürün açmadan (--no-create) çalışmış ya da bu teklifte hata vermiştir. Eşleştirme işini çalıştırt.",
  rejected_only:
    "Önerilen her ürün moderatör tarafından reddedildi. Resolver reddedilen ürünü bir daha önermez (karar 0040); sonraki koşuda başka bir aday yazar ya da yeni ürün açar.",
  invalid_gtin:
    "Teklif barkodu uzunluk ya da GS1 kontrol basamağı denetiminden geçmiyor; kesin kimlik eşleşmesinde güvenilmez.",
};

const DIAGNOSTIC_STATES: ReadonlySet<OfferState> = new Set<OfferState>([
  "unmatched",
  "no_candidate",
  "rejected_only",
  "invalid_gtin",
]);

/** Teklif inceleme (Faz 4, karar 0053): eşleşmemiş, adaysız, pasif ve bayat teklifler. Salt okunur. */
export default async function OffersPage({
  searchParams,
}: {
  searchParams: Promise<{ durum?: string; magaza?: string; q?: string; once?: string }>;
}) {
  const { actor } = await requireCapability("catalog.read");
  const params = await searchParams;
  const state: OfferState = isOfferState(params.durum) ? params.durum : "unmatched";
  const merchantId = positiveInt(params.magaza);
  const query = params.q?.trim().slice(0, 80) || undefined;
  const beforeId = positiveInt(params.once);

  const result = await listOffers(getDatabase(), actor, { state, merchantId, query, beforeId });
  const base = { durum: state, magaza: merchantId, q: query };
  const diagnostic = DIAGNOSTIC_STATES.has(state);
  const now = Date.now();
  const note = STATE_NOTES[state];

  return (
    <div className={styles.page}>
      <PageHeader title="Teklifler">
        <p className={styles.muted}>
          Eşleşmemiş teklifler eşleştirme işi (elle: python -m resolve) çalışınca ürüne bağlanır ya
          da kuyruğa düşer. Toplu bakış:{" "}
          <Link href="/yonetim/katalog/kalite">Katalog kalitesi</Link>
        </p>
      </PageHeader>

      {note ? <Notice>{note}</Notice> : null}

      <form action="/yonetim/katalog/teklifler" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Durum</span>
          <select name="durum" defaultValue={state}>
            {(Object.keys(STATE_LABELS) as OfferState[]).map((s) => (
              <option key={s} value={s}>
                {STATE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Başlık, mağaza ürün kimliği ya da #teklif</span>
          <input
            type="search"
            name="q"
            defaultValue={query ?? ""}
            maxLength={80}
            className={styles.textInput}
          />
        </label>
        {merchantId ? <input type="hidden" name="magaza" value={merchantId} /> : null}
        <button type="submit">Filtrele</button>
        {merchantId || query || state !== "unmatched" ? (
          <Link href="/yonetim/katalog/teklifler">Temizle</Link>
        ) : null}
      </form>

      {result.rows.length === 0 ? (
        <EmptyState title="Teklif yok." description="Bu filtreye uyan teklif bulunamadı." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Teklif</th>
                <th scope="col">Mağaza</th>
                <th scope="col" className={styles.num}>
                  Fiyat
                </th>
                <th scope="col">Ürün</th>
                {diagnostic ? <th scope="col">İlk görülme ve aday kanalları</th> : null}
                <th scope="col">Son görülme</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((o) => (
                <tr key={o.id}>
                  <td className={styles.num}>{o.id}</td>
                  <td>
                    {o.title}
                    <br />
                    <span className={styles.meta}>
                      {`${o.brand ?? "markasız"} · ${o.externalId}${o.isActive ? "" : " · pasif"}`}
                    </span>
                  </td>
                  <td>
                    <Link href={`/yonetim/magazalar/${o.merchantSlug}`}>{o.merchantName}</Link>
                  </td>
                  <td className={styles.num}>{formatKurus(o.price)}</td>
                  <td>
                    {o.productId ? (
                      <Link href={`/yonetim/katalog/urunler/${o.productId}`}>
                        {o.productSlug ?? `#${o.productId}`}
                      </Link>
                    ) : o.pendingCandidates > 0 ? (
                      <Link href="/yonetim/eslestirme">{`${o.pendingCandidates} aday kuyrukta`}</Link>
                    ) : o.rejectedCandidates > 0 ? (
                      `${o.rejectedCandidates} aday reddedildi`
                    ) : (
                      "—"
                    )}
                  </td>
                  {diagnostic ? (
                    <td>
                      {`${waitedText(now - o.firstSeenAt.getTime())} önce`}
                      <br />
                      <span className={styles.meta}>
                        {`barkod/MPN ${o.hasIdentifier ? "var" : "yok"} · görsel vektörü ${
                          o.hasImageVector ? "var" : "yok"
                        }${o.gtin ? ` · GTIN ${o.gtin}` : ""}`}
                      </span>
                    </td>
                  ) : null}
                  <td>{formatDateOrDash(o.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        first={beforeId ? hrefWith("/yonetim/katalog/teklifler", base) : null}
        next={
          result.nextBeforeId
            ? hrefWith("/yonetim/katalog/teklifler", { ...base, once: result.nextBeforeId })
            : null
        }
        nextLabel="Daha eski teklifler"
      />
    </div>
  );
}
