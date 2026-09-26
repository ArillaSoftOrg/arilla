import {
  consumeDiagnosticsQuota,
  DIAGNOSTIC_QUERY_MAX,
  DIAGNOSTICS_PER_MINUTE,
  type DiagnosticResultItem,
  explainSearch,
  SearchDiagnosticsInputError,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import type { ReactNode } from "react";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { ErrorNotice, KeyValues, Notice, PageHeader, Section } from "../../admin-ui.tsx";
import { formatDateOrDash, formatKurus } from "../../format.ts";

function ResultsTable({ items }: { items: DiagnosticResultItem[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.num}>
              Sıra
            </th>
            <th scope="col">Ürün</th>
            <th scope="col" className={styles.num}>
              Skor
            </th>
            <th scope="col" className={styles.num}>
              Fiyat
            </th>
            <th scope="col" className={styles.num}>
              Yüzdelik
            </th>
            <th scope="col" className={styles.num}>
              Güven
            </th>
            <th scope="col">Stok / teklif</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.productId}>
              <td className={styles.num}>{item.rank}</td>
              <td>
                <Link href={`/yonetim/katalog/urunler/${item.productId}`}>{item.title}</Link>
                <br />
                <span className={styles.meta}>
                  {`${item.brandName ?? "markasız"} · ${item.categoryPath ?? "kategorisiz"}`}
                </span>
              </td>
              <td className={styles.num}>{item.score.toFixed(3)}</td>
              <td className={styles.num}>{formatKurus(item.minPrice)}</td>
              <td className={styles.num}>{item.currentPercentile ?? "—"}</td>
              <td className={styles.num}>{item.merchantTrustScore ?? "—"}</td>
              <td>{`${item.inStock ? "stokta" : "stokta yok"} · ${item.offerCount}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SOURCE_LABELS = {
  conversation: "Netleştirme planı (sözlükten derlendi)",
  cache: "query_resolution önbelleği",
  fresh: "Taze ayrıştırma (önbellekte yok)",
} as const;

/**
 * Arama tanısı (Faz 4). Gerçek boru hattı, salt okunur: önbelleğe, arama
 * duvarı sayacına ve analitiğe yazmaz (core `explainSearch`).
 */
export default async function SearchDiagnosticsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sirala?: string }>;
}) {
  const { actor } = await requireCapability("diagnostics.read");
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const sort = params.sirala === "best_deal" ? "best_deal" : "balanced";

  let body: ReactNode = null;
  if (query) {
    if (!(await consumeDiagnosticsQuota(actor))) {
      body = (
        <ErrorNotice>{`Dakikada en fazla ${DIAGNOSTICS_PER_MINUTE} tanı çalıştırılabilir. Biraz bekle.`}</ErrorNotice>
      );
    } else {
      try {
        const d = await explainSearch(getDatabase(), actor, query, sort);
        body = (
          <>
            <Section id="ozet" title="Özet">
              <KeyValues
                items={[
                  ["Normalleştirilmiş", <code key="n">{d.queryNorm}</code>],
                  ["Aramaya giden sorgu", SOURCE_LABELS[d.effectiveSource]],
                  ["Sıralama", d.sort],
                  ["Toplam sonuç", String(d.total)],
                  ["Süre", `${d.elapsedMs} ms`],
                ]}
              />
            </Section>
            <Section id="onbellek" title="Önbellek (query_resolution)">
              {d.cache.present ? (
                <KeyValues
                  items={[
                    ["Kademe", String(d.cache.parserTier)],
                    ["Kullanım", String(d.cache.hitCount)],
                    ["Son kullanım", formatDateOrDash(d.cache.lastUsedAt)],
                    [
                      "Bugünkü sözlükle aynı mı",
                      d.cache.differsFromFresh
                        ? "Hayır — önbellek bayat, sözlük değişikliği yansımamış"
                        : "Evet",
                    ],
                  ]}
                />
              ) : (
                <p className={styles.muted}>
                  Bu sorgu önbellekte yok. Tanı önbelleğe yazmaz; ilk gerçek aramada oluşur.
                </p>
              )}
            </Section>
            <Section id="plan" title="Netleştirme planı">
              <KeyValues
                items={[
                  ["Mod", d.plan.mode],
                  ["Eylem", d.plan.action ?? "—"],
                  ["Soru", d.plan.question ?? "—"],
                  ["Anlaşılanlar", d.plan.constraints.join(", ") || "—"],
                ]}
              />
            </Section>
            <Section id="sozluk" title="Sözlük eşleşmeleri">
              {d.lexiconMatches.length === 0 ? (
                <p className={styles.muted}>Sözlükte eşleşen yüzey yok.</p>
              ) : (
                <ul className={styles.list}>
                  {d.lexiconMatches.map((m, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: aynı yüzey birden çok türde eşleşebilir.
                    <li key={i}>
                      <code>{m.surface}</code>
                      {` → ${m.normalized} (${m.kind}, ağırlık ${m.weight})`}
                    </li>
                  ))}
                </ul>
              )}
              <p className={styles.muted}>
                Eksik eşanlamlı ya da kategori için <Link href="/yonetim/sozluk">Sözlük</Link>.
              </p>
            </Section>
            <Section id="sorgu" title="Sorgu nesnesi">
              <details>
                <summary className={styles.detailsSummary}>Aramaya giden sorgu</summary>
                <pre className={styles.mono}>{JSON.stringify(d.effectiveQuery, null, 2)}</pre>
              </details>
              <details>
                <summary className={styles.detailsSummary}>Taze ayrıştırma</summary>
                <pre className={styles.mono}>{JSON.stringify(d.freshParse, null, 2)}</pre>
              </details>
            </Section>
            <Section id="sonuclar" title="Sonuçlar (ilk 20)">
              {d.results.length > 0 ? (
                <ResultsTable items={d.results} />
              ) : (
                <>
                  <Notice>
                    Sonuç yok. /ara bu durumda filtreleri kaldırıp aşağıdaki yedek sonuçları
                    gösterir.
                  </Notice>
                  {d.fallback && d.fallback.length > 0 ? (
                    <ResultsTable items={d.fallback} />
                  ) : (
                    <p className={styles.muted}>Yedek sonuç da yok.</p>
                  )}
                </>
              )}
            </Section>
          </>
        );
      } catch (error) {
        if (error instanceof SearchDiagnosticsInputError) {
          body = <ErrorNotice>{error.message}</ErrorNotice>;
        } else {
          const timeout = (error as { cause?: { code?: string } })?.cause?.code === "57014";
          body = (
            <ErrorNotice>
              {timeout ? "Tanı zaman aşımına uğradı (8 sn)." : "Tanı çalıştırılamadı."}
            </ErrorNotice>
          );
        }
      }
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader title="Arama tanısı">
        <p className={styles.muted}>
          Bir sorgunun /ara'da nasıl işlendiğini gösterir. Gerçek arama çalışır ama önbelleğe, arama
          sayacına ve analitiğe yazılmaz.
        </p>
      </PageHeader>
      <form action="/yonetim/arama/tani" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Sorgu</span>
          <input
            type="search"
            name="q"
            defaultValue={query}
            maxLength={DIAGNOSTIC_QUERY_MAX}
            required
            className={styles.textInput}
          />
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Sıralama</span>
          <select name="sirala" defaultValue={sort}>
            <option value="balanced">Bizim seçtiklerimiz</option>
            <option value="best_deal">En iyi fırsatlar</option>
          </select>
        </label>
        <button type="submit">Çalıştır</button>
      </form>
      {body}
    </div>
  );
}
