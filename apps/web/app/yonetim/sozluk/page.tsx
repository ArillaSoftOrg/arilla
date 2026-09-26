import { isLexiconKind, LEXICON_KINDS, listLexicon, recentTier3Queries } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { LexiconTableClient } from "./lexicon-table-client.tsx";

const PAGE_SIZE = 50;
/** Ofset sayfalaması: çok derin sayfa isteği sınırlanır. */
const MAX_PAGE = 1000;

interface SozlukSearchParams {
  tur?: string;
  q?: string;
  sayfa?: string;
}

function parsePage(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_PAGE) : 1;
}

/**
 * docs/pages.md "/yonetim/sozluk": tablo görünümü, satır içi düzenleme, tür
 * filtresi, arama; üstte son 7 günde kademe 3'e düşen sorgular. Kademe 3
 * henüz yazılmadı (C1 yalnızca kademe 2) — o liste şimdilik her zaman boş.
 */
export default async function LexiconPage({
  searchParams,
}: {
  searchParams: Promise<SozlukSearchParams>;
}) {
  await requireCapability("dictionary.write");

  const { tur, q, sayfa } = await searchParams;
  const kind = isLexiconKind(tur) ? tur : undefined;
  const search = q?.trim().slice(0, 80) || undefined;
  const page = parsePage(sayfa);

  const db = getDatabase();
  const [fetched, tier3] = await Promise.all([
    // Bir fazlası: sonraki sayfa var mı, COUNT çalıştırmadan.
    listLexicon(db, { kind, search, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE }),
    recentTier3Queries(db),
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

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Sözlük</h1>
        <p className={styles.muted}>
          Kaydedilen değişiklik aramayı hemen etkiler ve denetim kaydına yazılır.
        </p>
      </header>

      <section className={styles.pageHeader} aria-labelledby="kademe3">
        <h2 id="kademe3" className={styles.sectionTitle}>
          Son 7 günde kademe 3'e düşen sorgular
        </h2>
        {tier3.length === 0 ? (
          <p className={styles.muted}>
            Şu an aday yok. Kademe 3 (model) henüz devrede değil; o zamana kadar bu liste boş kalır.
          </p>
        ) : (
          <ul className={styles.list}>
            {tier3.map((row) => (
              <li key={row.queryNorm}>
                {row.queryNorm} — {row.hitCount} kez
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action="/yonetim/sozluk" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Tür</span>
          <select name="tur" defaultValue={kind ?? ""}>
            <option value="">Tümü</option>
            {LEXICON_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
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

      {rows.length === 0 && page === 1 ? (
        <EmptyState title="Sözlükte satır yok." description="Yeni bir satır ekleyerek başla." />
      ) : null}
      <LexiconTableClient rows={rows} />

      <nav className={styles.pager} aria-label="Sayfalar">
        {page > 1 ? <Link href={href({ tur: kind, sayfa: page - 1 })}>Önceki</Link> : null}
        {page > 1 || hasNext ? <span className={styles.meta}>{`Sayfa ${page}`}</span> : null}
        {hasNext ? <Link href={href({ tur: kind, sayfa: page + 1 })}>Sonraki</Link> : null}
      </nav>
    </div>
  );
}
