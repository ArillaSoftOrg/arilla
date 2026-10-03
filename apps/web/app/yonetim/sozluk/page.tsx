import {
  hasCapability,
  isLexiconKind,
  LEXICON_KINDS,
  LEXICON_SURFACE_MAX,
  listLexicon,
  listSearchQualityQueries,
  SEARCH_QUALITY_KINDS,
  SEARCH_QUALITY_WINDOWS,
  type SearchQualityListing,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { Pager } from "../admin-ui.tsx";
import {
  diagnosticsHref,
  formatDateOrDash,
  hrefWith,
  lexiconKindLabel,
  searchQualityKindLabel,
} from "../format.ts";
import { LexiconTableClient } from "./lexicon-table-client.tsx";

const PAGE_SIZE = 50;
/** Ofset sayfalaması: çok derin sayfa isteği sınırlanır. */
const MAX_PAGE = 1000;

interface SozlukSearchParams {
  tur?: string;
  q?: string;
  sayfa?: string;
  /** Sorunlu sorgular: pencere (7|30), tür, sayfa. */
  gun?: string;
  sorun?: string;
  ssayfa?: string;
  /** "Sözlüğe ekle": yeni satır formunun yüzeyi ve doğrulanacak sorgu. */
  ekle?: string;
  dogrula?: string;
}

function parsePage(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_PAGE) : 1;
}

type QualityLinks = (next: { gun?: number; sorun?: string; ssayfa?: number }) => string;

function addHref(term: string | undefined, query?: string): string {
  return hrefWith("/yonetim/sozluk", { ekle: term, dogrula: query });
}

function ProblemQueries({
  listing,
  links,
}: {
  listing: SearchQualityListing;
  links: QualityLinks;
}) {
  const t = listing.totals;
  const here = { gun: listing.days, sorun: listing.kind };
  return (
    <section className={styles.pageHeader} aria-labelledby="sorunlu">
      <h2 id="sorunlu" className={styles.sectionTitle}>
        Sorunlu sorgular
      </h2>
      <p className={styles.muted}>
        {`Son ${listing.days} gün: ${t.searches} arama, ${t.queries} farklı sorgu, ${t.zeroResults} sonuçsuz, ${t.fallbacks} yedek listeye düşen. Kimliksiz günlük özet; yalnızca /ara metin araması sayılır.`}
      </p>
      <nav className={styles.s2Actions} aria-label="Sorunlu sorgu süzgeci">
        {SEARCH_QUALITY_WINDOWS.map((gun) =>
          gun === listing.days ? (
            <strong key={gun}>{`Son ${gun} gün`}</strong>
          ) : (
            <Link key={gun} href={links({ gun, sorun: listing.kind })}>
              {`Son ${gun} gün`}
            </Link>
          ),
        )}
        <span className={styles.meta}>·</span>
        {SEARCH_QUALITY_KINDS.map((kind) =>
          kind === listing.kind ? (
            <strong key={kind}>{searchQualityKindLabel(kind)}</strong>
          ) : (
            <Link key={kind} href={links({ gun: listing.days, sorun: kind })}>
              {searchQualityKindLabel(kind)}
            </Link>
          ),
        )}
      </nav>
      {listing.rows.length === 0 ? (
        <p className={styles.muted}>Bu süzgeçte sorgu yok.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Sorgu</th>
                <th scope="col" className={styles.num}>
                  Arama
                </th>
                <th scope="col" className={styles.num}>
                  Sonuçsuz
                </th>
                <th scope="col" className={styles.num}>
                  Yedek
                </th>
                <th scope="col" className={styles.num}>
                  Netleştirme
                </th>
                <th scope="col" className={styles.num}>
                  Son sonuç
                </th>
                <th scope="col">Tanınmayan kelimeler</th>
                <th scope="col">Son görülme</th>
                <th scope="col">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {listing.rows.map((row) => (
                <tr key={row.queryNorm}>
                  <td>
                    <code>{row.queryNorm}</code>
                  </td>
                  <td className={styles.num}>{row.searches}</td>
                  <td className={styles.num}>{row.zeroResults}</td>
                  <td className={styles.num}>{row.fallbacks}</td>
                  <td className={styles.num}>{row.clarifications}</td>
                  <td className={styles.num}>{row.lastResultCount ?? "—"}</td>
                  <td>
                    {row.unrecognizedTerms.length === 0 ? (
                      "—"
                    ) : (
                      <ul className={styles.s2Chips}>
                        {row.unrecognizedTerms.map((term) => (
                          <li key={term} className={styles.s2Chip}>
                            <Link href={addHref(term, row.queryNorm)}>{term}</Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>{formatDateOrDash(row.lastSeenAt)}</td>
                  <td>
                    <div className={styles.s2Actions}>
                      <Link href={diagnosticsHref(row.queryNorm)}>İncele</Link>
                      <Link
                        href={addHref(
                          row.unrecognizedTerms[0] ?? row.queryNorm.split(" ").at(-1),
                          row.queryNorm,
                        )}
                      >
                        Sözlüğe ekle
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        prev={listing.page > 1 ? links({ ...here, ssayfa: listing.page - 1 }) : null}
        next={listing.hasNext ? links({ ...here, ssayfa: listing.page + 1 }) : null}
        label={listing.page > 1 || listing.hasNext ? `Sayfa ${listing.page}` : undefined}
      />
      {listing.terms.length > 0 ? (
        <>
          <h3 className={styles.s2StepTitle}>Sık tanınmayan kelimeler</h3>
          <ul className={styles.s2Chips}>
            {listing.terms.map((term) => (
              <li key={term.term} className={styles.s2Chip}>
                <Link href={addHref(term.term)}>{term.term}</Link>
                <span className={styles.meta}>
                  {` ${term.searches} arama · ${term.queries} sorgu`}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/**
 * docs/pages.md "/yonetim/sozluk": tablo görünümü, satır içi düzenleme, tür
 * filtresi, arama. Üstte "Sorunlu sorgular" (karar 0054): sonuçsuz, yedek
 * listeye düşen ve tanınmayan kelimeli sorgular. Akış: sorun → İncele (tanı)
 * → Sözlüğe ekle (form ön dolu, kaydetmeden yazılmaz) → tanıda doğrula.
 * Otomatik yazma ya da model önerisi yok. Eski "kademe 3" listesi kaldırıldı:
 * model kademesi yok, liste hep boştu.
 */
export default async function LexiconPage({
  searchParams,
}: {
  searchParams: Promise<SozlukSearchParams>;
}) {
  const { actor } = await requireCapability("dictionary.write");

  const { tur, q, sayfa, gun, sorun, ssayfa, ekle, dogrula } = await searchParams;
  const kind = isLexiconKind(tur) ? tur : undefined;
  const search = q?.trim().slice(0, 80) || undefined;
  const page = parsePage(sayfa);
  const prefillSurface =
    typeof ekle === "string" && ekle.trim() ? ekle.trim().slice(0, LEXICON_SURFACE_MAX) : null;
  const verifyQuery =
    typeof dogrula === "string" && dogrula.trim() ? dogrula.trim().slice(0, 200) : null;
  // Kullanıcı sorgularını okumak arama gözlemidir: `diagnostics.read` de gerekir.
  const canSeeQueries = hasCapability(actor.role, "diagnostics.read");

  const db = getDatabase();
  const [fetched, quality] = await Promise.all([
    // Bir fazlası: sonraki sayfa var mı, COUNT çalıştırmadan.
    listLexicon(db, { kind, search, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE }),
    canSeeQueries
      ? listSearchQualityQueries(db, actor, { days: Number(gun), kind: sorun, page: ssayfa })
      : Promise.resolve(null),
  ]);
  const rows = fetched.slice(0, PAGE_SIZE);
  const hasNext = fetched.length > PAGE_SIZE;

  function href(next: { tur?: string; sayfa?: number }): string {
    const params = new URLSearchParams();
    if (next.tur) params.set("tur", next.tur);
    if (search) params.set("q", search);
    if (next.sayfa && next.sayfa > 1) params.set("sayfa", String(next.sayfa));
    const qs = params.toString();
    return qs ? `/yonetim/sozluk?${qs}` : "/yonetim/sozluk";
  }

  function qualityHref(next: { gun?: number; sorun?: string; ssayfa?: number }): string {
    return `${hrefWith("/yonetim/sozluk", {
      gun: next.gun,
      sorun: next.sorun,
      ssayfa: next.ssayfa && next.ssayfa > 1 ? next.ssayfa : undefined,
    })}#sorunlu`;
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Sözlük</h1>
        <p className={styles.muted}>
          Kaydedilen değişiklik aramayı hemen etkiler ve denetim kaydına yazılır.
        </p>
      </header>

      {quality ? <ProblemQueries listing={quality} links={qualityHref} /> : null}

      <form action="/yonetim/sozluk" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Tür</span>
          <select name="tur" defaultValue={kind ?? ""}>
            <option value="">Tümü</option>
            {LEXICON_KINDS.map((k) => (
              <option key={k} value={k}>
                {lexiconKindLabel(k)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Ara</span>
          <input type="text" name="q" defaultValue={search ?? ""} maxLength={80} />
        </label>
        <button type="submit">Filtrele</button>
        {kind || search ? <Link href="/yonetim/sozluk">Temizle</Link> : null}
      </form>

      {prefillSurface ? (
        <p className={styles.notice} role="status">
          {`"${prefillSurface}" için yeni satır formu açık. Türü ve karşılığı seç; kaydetmeden hiçbir şey yazılmaz.`}
          {verifyQuery ? (
            <>
              {" "}
              <Link href={diagnosticsHref(verifyQuery)}>Sorguyu tanıda incele</Link>
            </>
          ) : null}
        </p>
      ) : null}

      {rows.length === 0 && page === 1 ? (
        <EmptyState title="Sözlükte satır yok." description="Yeni bir satır ekleyerek başla." />
      ) : null}
      <LexiconTableClient
        rows={rows}
        prefillSurface={prefillSurface}
        verifyHref={verifyQuery ? diagnosticsHref(verifyQuery) : null}
      />

      <nav className={styles.pager} aria-label="Sayfalar">
        {page > 1 ? <Link href={href({ tur: kind, sayfa: page - 1 })}>Önceki</Link> : null}
        {page > 1 || hasNext ? <span className={styles.meta}>{`Sayfa ${page}`}</span> : null}
        {hasNext ? <Link href={href({ tur: kind, sayfa: page + 1 })}>Sonraki</Link> : null}
      </nav>
    </div>
  );
}
