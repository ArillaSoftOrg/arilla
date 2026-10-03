import {
  consumeDiagnosticsQuota,
  DIAGNOSTIC_QUERY_MAX,
  DIAGNOSTICS_PER_MINUTE,
  type DiagnosticResultItem,
  explainProductAbsence,
  explainSearch,
  PRODUCT_REF_MAX,
  type ProductAbsenceDiagnostics,
  ProductRefInputError,
  type SearchDiagnostics,
  SearchDiagnosticsInputError,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import type { ReactNode } from "react";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { ErrorNotice, KeyValues, Notice, PageHeader, Section } from "../../admin-ui.tsx";
import {
  diagnosticsHref,
  formatDateOrDash,
  formatFactor,
  formatKurus,
  hrefWith,
  lexiconKindLabel,
  searchFilterLabel,
} from "../../format.ts";

function ResultsTable({
  items,
  showFactors,
}: {
  items: DiagnosticResultItem[];
  showFactors: "balanced" | "best_deal" | null;
}) {
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
            {showFactors ? (
              <th scope="col" className={styles.num}>
                Metin alakası
              </th>
            ) : null}
            {showFactors === "balanced" ? (
              <>
                <th scope="col" className={styles.num}>
                  × Güven
                </th>
                <th scope="col" className={styles.num}>
                  × Stok
                </th>
                <th scope="col" className={styles.num}>
                  × Fiyat
                </th>
              </>
            ) : null}
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
                  {`#${item.productId} · ${item.brandName ?? "markasız"} · ${item.categoryPath ?? "kategorisiz"}`}
                </span>
              </td>
              <td className={styles.num}>{item.score.toFixed(4)}</td>
              {showFactors ? (
                <td className={styles.num}>{formatFactor(item.factors?.relevance)}</td>
              ) : null}
              {showFactors === "balanced" ? (
                <>
                  <td className={styles.num}>{formatFactor(item.factors?.trust)}</td>
                  <td className={styles.num}>{formatFactor(item.factors?.stock)}</td>
                  <td className={styles.num}>{formatFactor(item.factors?.price)}</td>
                </>
              ) : null}
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

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className={styles.s2Step}>
      <h3 className={styles.s2StepTitle}>{title}</h3>
      {children}
    </li>
  );
}

function listOrDash(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "—";
}

function Pipeline({ d }: { d: SearchDiagnostics }) {
  const q = d.effectiveQuery;
  const f = q.filters ?? {};
  const priceRange =
    f.price_min != null || f.price_max != null
      ? `${f.price_min != null ? formatKurus(f.price_min) : "…"} – ${f.price_max != null ? formatKurus(f.price_max) : "…"}`
      : "—";
  const funnel = d.funnel;
  const activeRejects = funnel.filterRejects.filter((r) => r.rejected > 0);
  const showFactors =
    d.results.length > 0 ? (d.sort === "best_deal" ? "best_deal" : "balanced") : null;
  const headWord = d.queryNorm.split(" ").at(-1);

  return (
    <ol className={styles.s2Steps}>
      <Step title="Sorgu">
        <KeyValues
          items={[
            ["Girilen", <code key="i">{d.input}</code>],
            ["Normalleştirilmiş", <code key="n">{d.queryNorm}</code>],
          ]}
        />
      </Step>

      <Step title="Ayrıştırıcı">
        <KeyValues
          items={[
            ["Aramaya giden sorgu", SOURCE_LABELS[d.effectiveSource]],
            ["Kademe", "2 — sözlük (model kademesi yok)"],
            ["Güven", q.confidence.toFixed(2)],
            [
              "Önbellek",
              d.cache.present
                ? `var · ${d.cache.hitCount} kullanım · son ${formatDateOrDash(d.cache.lastUsedAt)}${
                    d.cache.differsFromFresh ? " · bayat: bugünkü sözlükle farklı" : ""
                  }`
                : "yok (tanı önbelleğe yazmaz)",
            ],
          ]}
        />
      </Step>

      <Step title="Sözlük eşleşmeleri">
        {d.lexiconMatches.length === 0 ? (
          <p className={styles.muted}>Sözlükte eşleşen yüzey yok.</p>
        ) : (
          <ul className={styles.list}>
            {d.lexiconMatches.map((m, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: aynı yüzey birden çok türde eşleşebilir.
              <li key={i}>
                <code>{m.surface}</code>
                {` → ${m.normalized} (${lexiconKindLabel(m.kind)}, ağırlık ${m.weight})`}
              </li>
            ))}
          </ul>
        )}
      </Step>

      <Step title="Anlaşılanlar">
        <KeyValues
          items={[
            ["Marka", listOrDash(f.brand_include)],
            ["Hariç marka", listOrDash(f.brand_exclude)],
            ["Kategori", f.category_path ?? "—"],
            ["Renk", listOrDash(f.color)],
            ["Fiyat aralığı", priceRange],
            ["Beden", f.size_norm ?? "—"],
            ["Yalnızca stokta", f.in_stock_only ? "evet" : "hayır"],
            ["Stil", listOrDash(q.style_tags)],
            ["Kalan metin", q.unparsed ? <code key="u">{q.unparsed}</code> : "—"],
          ]}
        />
      </Step>

      <Step title="Aday kapıları">
        <KeyValues
          items={[
            [
              "Metin slotları",
              funnel.textSlots.length === 0
                ? "metin yok — metin kapısı uygulanmaz"
                : `${funnel.textSlots.map((s) => `[${s.join(" | ")}]`).join(" ")} · en az ${funnel.requiredSlots}/${funnel.textSlots.length} slot, son slot (baş isim) zorunlu`,
            ],
            [
              funnel.textSlots.length === 0 ? "Katalog" : "Baş isim ön filtresi",
              String(funnel.prefilter),
            ],
            ["Aktif mağazada aktif teklif", String(funnel.withActiveOffer)],
            ["Metin kapısı", String(funnel.textGate)],
            ["Filtreler", String(funnel.filters)],
            ...(d.sort === "best_deal"
              ? ([["Fiyat istatistiği, şişik değil", String(funnel.priceStats)]] as [
                  string,
                  ReactNode,
                ][])
              : []),
            ["Aynı görselden tek kart", String(funnel.afterImageDedup)],
          ]}
        />
        {activeRejects.length > 0 ? (
          <p className={styles.meta}>
            {`Metin kapısından geçenler içinde filtrelerin tek başına eledikleri: ${activeRejects
              .map((r) => `${searchFilterLabel(r.name)} ${r.rejected}`)
              .join(", ")}`}
          </p>
        ) : null}
      </Step>

      <Step title="Sıralama">
        <p className={styles.muted}>
          {d.sort === "best_deal"
            ? "En iyi fırsatlar: skor = 100 − fiyat yüzdeliği; sıra yüzdeliğe göre artan. Metin alakası yalnızca kapı içindir."
            : "Bizim seçtiklerimiz: skor = metin alakası × (güven/100) × stok çarpanı × (1 − yüzdelik/100). Çarpanlar sıralamanın kendi SQL ifadelerinden okunur."}
        </p>
        {d.results.length > 0 ? (
          <ResultsTable items={d.results} showFactors={showFactors} />
        ) : (
          <p className={styles.muted}>Sıralanacak aday yok.</p>
        )}
      </Step>

      <Step title="Netleştirme">
        <KeyValues
          items={[
            ["Mod", d.plan.mode === "conversation" ? "konuşma" : "klasik"],
            ["Eylem", d.plan.action ?? "—"],
            ["Soru", d.plan.question ?? "—"],
            ["Anlaşılanlar", d.plan.constraints.join(", ") || "—"],
          ]}
        />
      </Step>

      <Step title="Sonuç">
        <KeyValues
          items={[
            ["Toplam sonuç", String(d.total)],
            ["Süre", `${d.elapsedMs} ms`],
          ]}
        />
        {d.results.length === 0 ? (
          <>
            <Notice>
              Sonuç yok. /ara bu durumda filtreleri kaldırıp aşağıdaki yedek sonuçları gösterir.
            </Notice>
            {d.fallback && d.fallback.length > 0 ? (
              <ResultsTable items={d.fallback} showFactors={null} />
            ) : (
              <p className={styles.muted}>Yedek sonuç da yok.</p>
            )}
          </>
        ) : null}
        <p className={styles.muted}>
          Eksik eş anlamlı ya da kategori için{" "}
          <Link href={hrefWith("/yonetim/sozluk", { ekle: headWord, dogrula: d.input })}>
            sözlüğe ekle
          </Link>
          .
        </p>
      </Step>
    </ol>
  );
}

function AbsenceView({ a }: { a: ProductAbsenceDiagnostics }) {
  if (!a.probe) {
    return <Notice>Bu kimlik ya da adres adıyla ürün yok.</Notice>;
  }
  const p = a.probe;
  const verdict =
    p.rank === null
      ? "Listede değil."
      : p.rank <= a.shownLimit
        ? `Listede: ${p.rank}. sıra (toplam ${p.total}).`
        : `Listede ama ilk ${a.shownLimit} içinde değil: ${p.rank}. sıra (toplam ${p.total}).`;
  return (
    <>
      <KeyValues
        items={[
          [
            "Ürün",
            <Link key="p" href={`/yonetim/katalog/urunler/${p.productId}`}>
              {`#${p.productId} ${p.title}`}
            </Link>,
          ],
          ["Durum", verdict],
          [
            "Teklifler",
            `${p.offers.total} toplam · ${p.offers.active} aktif · ${p.offers.activeOnActiveMerchant} aktif mağazada · ${p.offers.activeInStock} stokta`,
          ],
          [
            "Metin kapısı",
            p.text
              ? `${p.textGatePass ? "geçti" : "geçmedi"} · ön filtre ${p.prefilterPass ? "geçti" : "geçmedi"} · baş isim ${p.text.head.toFixed(2)} · eşleşen ${p.text.matched}/${p.text.required} · alaka ${p.text.relevance.toFixed(3)}`
              : "metin yok",
          ],
          [
            "Filtreler",
            p.predicates
              .map((x) => `${searchFilterLabel(x.name)}: ${x.pass ? "uyuyor" : "uymuyor"}`)
              .join(" · "),
          ],
          [
            "Skor",
            p.score === null
              ? "—"
              : `${p.score.toFixed(4)} (alaka ${formatFactor(p.factors?.relevance)}, güven ${formatFactor(p.factors?.trust)}, stok ${formatFactor(p.factors?.stock)}, fiyat ${formatFactor(p.factors?.price)})`,
          ],
        ]}
      />
      {a.reasons.length > 0 ? (
        <ul className={styles.list}>
          {a.reasons.map((r) => (
            <li key={`${r.code}-${r.filter ?? ""}`}>{r.text}</li>
          ))}
        </ul>
      ) : null}
      {p.hiddenByImageOf ? (
        <p className={styles.meta}>
          Görseli taşıyan ürün:{" "}
          <Link href={`/yonetim/katalog/urunler/${p.hiddenByImageOf.productId}`}>
            {`#${p.hiddenByImageOf.productId} ${p.hiddenByImageOf.title}`}
          </Link>
        </p>
      ) : null}
    </>
  );
}

function errorBody(error: unknown): ReactNode {
  if (error instanceof SearchDiagnosticsInputError || error instanceof ProductRefInputError) {
    return <ErrorNotice>{error.message}</ErrorNotice>;
  }
  const timeout = (error as { cause?: { code?: string } })?.cause?.code === "57014";
  return (
    <ErrorNotice>
      {timeout ? "Tanı zaman aşımına uğradı (8 sn)." : "Tanı çalıştırılamadı."}
    </ErrorNotice>
  );
}

const QUOTA_MESSAGE = `Dakikada en fazla ${DIAGNOSTICS_PER_MINUTE} tanı çalıştırılabilir. Biraz bekle.`;

/**
 * Arama tanısı. Gerçek boru hattı adım adım, salt okunur: önbelleğe, arama
 * duvarı sayacına, arama kalitesi özetine ve analitiğe yazmaz (core
 * `explainSearch`, `explainProductAbsence`). Her çalıştırma tanı kotasından düşer.
 */
export default async function SearchDiagnosticsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sirala?: string; urun?: string }>;
}) {
  const { actor } = await requireCapability("diagnostics.read");
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const productRef = typeof params.urun === "string" ? params.urun.trim() : "";
  const sort = params.sirala === "best_deal" ? "best_deal" : "balanced";

  let body: ReactNode = null;
  let absence: ReactNode = null;
  if (query) {
    if (!(await consumeDiagnosticsQuota(actor))) {
      body = <ErrorNotice>{QUOTA_MESSAGE}</ErrorNotice>;
    } else {
      try {
        const d = await explainSearch(getDatabase(), actor, query, sort);
        body = (
          <>
            <Section id="adimlar" title="Boru hattı">
              <Pipeline d={d} />
            </Section>
            <Section id="ham" title="Ham veri">
              <details>
                <summary className={styles.detailsSummary}>Aramaya giden sorgu (JSON)</summary>
                <pre className={styles.mono}>{JSON.stringify(d.effectiveQuery, null, 2)}</pre>
              </details>
              <details>
                <summary className={styles.detailsSummary}>Taze ayrıştırma (JSON)</summary>
                <pre className={styles.mono}>{JSON.stringify(d.freshParse, null, 2)}</pre>
              </details>
            </Section>
          </>
        );
      } catch (error) {
        body = errorBody(error);
      }

      if (productRef) {
        if (!(await consumeDiagnosticsQuota(actor))) {
          absence = <ErrorNotice>{QUOTA_MESSAGE}</ErrorNotice>;
        } else {
          try {
            const a = await explainProductAbsence(getDatabase(), actor, query, productRef, sort);
            absence = <AbsenceView a={a} />;
          } catch (error) {
            absence = errorBody(error);
          }
        }
      }
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader title="Arama tanısı">
        <p className={styles.muted}>
          Bir sorgunun /ara'da nasıl işlendiğini adım adım gösterir. Gerçek arama çalışır ama
          önbelleğe, arama sayacına, arama kalitesi özetine ve analitiğe yazılmaz.
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
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Ürün (isteğe bağlı: kimlik ya da adres adı)</span>
          <input
            type="text"
            name="urun"
            defaultValue={productRef}
            maxLength={PRODUCT_REF_MAX}
            className={styles.textInput}
          />
        </label>
        <button type="submit">Çalıştır</button>
      </form>
      {query && productRef ? (
        <Section id="urun-neden" title="Bu ürün neden burada değil?">
          {absence}
          <p className={styles.meta}>
            <Link href={diagnosticsHref(query)}>Ürün sorgusunu kaldır</Link>
          </p>
        </Section>
      ) : null}
      {body}
    </div>
  );
}
