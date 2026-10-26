import {
  type AdminActor,
  activeFilterCount,
  getProductPanel,
  isProductIssueFilter,
  listProductFilterOptions,
  PRODUCT_CLASSIFICATION_FILTERS,
  PRODUCT_CONFIDENCE_FILTERS,
  PRODUCT_FRESHNESS_FILTERS,
  PRODUCT_IMAGE_FILTERS,
  PRODUCT_PRICE_FILTERS,
  PRODUCT_STATE_FILTERS,
  type ProductFilterKey,
  type ProductIssueFilter,
  type ProductListParams,
  type ProductQualityFilter,
  parseProductListParams,
  searchProducts,
  UNASSIGNED,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import {
  EmptyPanel,
  ErrorNotice,
  PageHeader,
  Pager,
  Skeleton,
  StatusBadge,
} from "../../admin-ui.tsx";
import {
  formatCount,
  formatDateOrDash,
  formatForeignPrices,
  formatKurus,
  formatPercent,
  hrefWith,
} from "../../format.ts";
import { catalogCounts } from "./catalog-counts.ts";
import {
  CLASSIFICATION_FILTER_LABELS,
  CONFIDENCE_LABELS,
  classificationBadge,
  confidenceTone,
  FRESHNESS_LABELS,
  IMAGE_LABELS,
  PRICE_LABELS,
  publicationBadge,
  QUALITY_LABELS,
  STATE_LABELS,
  shortCategory,
} from "./product-labels.ts";
import {
  PendingRegion,
  ProductDrawer,
  ProductFilterForm,
  ProductListShell,
  ProductRowLink,
} from "./product-list-client.tsx";
import { ProductPanelView } from "./product-panel.tsx";
import { ProductThumb } from "./product-thumb-client.tsx";
import local from "./products.module.css";

const PATH = "/yonetim/katalog/urunler";

/** Katalog kalitesi bağlantılarının filtresi (karar 0053); sayaç panelinde yok. */
const ISSUE_LABELS: Record<ProductIssueFilter, string> = {
  no_active_offer: "Aktif teklifi olmayan ürünler (canlı)",
  duplicate_gtin: "Barkodu başka bir üründe de olan ürünler",
};

type FilterState = Partial<Record<ProductFilterKey, string>>;

function listHref(state: FilterState, extra: Record<string, string | number | undefined> = {}) {
  return hrefWith(PATH, { ...state, ...extra });
}

function without(state: FilterState, key: ProductFilterKey): FilterState {
  const next = { ...state };
  delete next[key];
  return next;
}

/**
 * Katalog inceleme (Faz 4, karar 0133 görünürlüğü). SALT OKUNUR: genel tablo
 * düzenleyici değildir. Liste sunucuda süzülür ve sayfalanır (anahtar kümeli,
 * toplam sayım yok); üst sayılar kısa süre önbellekli ve ayrı akar (liste
 * onları beklemez). `?urun=<id>` sağ paneli açar.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<ProductListParams>;
}) {
  const { actor } = await requireCapability("catalog.read");
  const params = await searchParams;
  const parsed = parseProductListParams(params);
  const { state, panelId } = parsed;
  // Kategori seçeneklerinde yalnız ana/ikinci seviye + seçili dal gelir (karar 0153).
  const options = await listProductFilterOptions(getDatabase(), actor, state.kategori);
  const activeCount = activeFilterCount(state);
  const cursor = { once: params.once, sonra: params.sonra };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Ürünler"
        description="Kanonik ürünler: sınıflandırma, fiyat ve yayın durumu. Salt okunur."
        actions={<Link href="/yonetim/katalog/siniflandirma">Sınıflandırma izleme</Link>}
      />

      <Suspense fallback={<StatsSkeleton />}>
        <ProductStats actor={actor} state={state} />
      </Suspense>

      <ProductListShell>
        <ProductFilterForm activeCount={activeCount} values={state}>
          <div className={local.filterGrid}>
            <label className={`${styles.filterField} ${local.filterSearch}`}>
              <span className={styles.filterLabel}>
                Ara: kimlik, GTIN, kaynak kimliği ya da başlık
              </span>
              <input
                type="search"
                name="q"
                defaultValue={state.q ?? ""}
                placeholder="Kimlik, GTIN, kaynak kimliği ya da başlık"
                maxLength={80}
                className={styles.textInput}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <SelectField label="Yayın durumu" name="durum" value={state.durum ?? "published"}>
              {PRODUCT_STATE_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {STATE_LABELS[value]}
                </option>
              ))}
            </SelectField>
            <SelectField label="Mağaza (aktif teklif)" name="magaza" value={state.magaza ?? ""}>
              <option value="">Tümü</option>
              {options.merchants.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.isActive ? m.name : `${m.name} (kapalı)`}
                </option>
              ))}
            </SelectField>
            <label className={styles.filterField}>
              <span className={styles.filterLabel}>Marka</span>
              <input
                type="search"
                name="marka"
                defaultValue={state.marka ?? ""}
                placeholder="Ad, kimlik ya da none"
                maxLength={80}
                className={styles.textInput}
                autoComplete="off"
              />
            </label>
            <SelectField
              label="Kategori (alt dallar dahil; seçince bir alt seviye açılır)"
              name="kategori"
              value={state.kategori ?? ""}
            >
              <option value="">Tümü</option>
              <option value={UNASSIGNED}>Kategorisiz</option>
              {options.categories.map((c) => (
                <option key={c.path} value={c.path}>
                  {`${"  ".repeat(c.depth)}${c.name}`}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Sınıflandırma"
              name="siniflandirma"
              value={state.siniflandirma ?? ""}
            >
              <option value="">Tümü</option>
              {PRODUCT_CLASSIFICATION_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {CLASSIFICATION_FILTER_LABELS[value]}
                </option>
              ))}
            </SelectField>
            <SelectField label="Güven puanı (kategori)" name="guven" value={state.guven ?? ""}>
              <option value="">Tümü</option>
              {PRODUCT_CONFIDENCE_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {CONFIDENCE_LABELS[value]}
                </option>
              ))}
            </SelectField>
            <SelectField label="Fiyat" name="fiyat" value={state.fiyat ?? ""}>
              <option value="">Tümü</option>
              {PRODUCT_PRICE_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {PRICE_LABELS[value]}
                </option>
              ))}
            </SelectField>
            <SelectField label="Görsel" name="gorsel" value={state.gorsel ?? ""}>
              <option value="">Tümü</option>
              {PRODUCT_IMAGE_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {IMAGE_LABELS[value]}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Fiyat özeti güncelliği"
              name="guncellik"
              value={state.guncellik ?? ""}
            >
              <option value="">Tümü</option>
              {PRODUCT_FRESHNESS_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {FRESHNESS_LABELS[value]}
                </option>
              ))}
            </SelectField>
          </div>
          {/* Kalite kartlarından ve kalite sayfasından gelen filtreler formda korunur. */}
          {state.kalite ? <input type="hidden" name="kalite" value={state.kalite} /> : null}
          {state.sorun ? <input type="hidden" name="sorun" value={state.sorun} /> : null}
          <div className={local.filterFoot}>
            <p className={local.filterHint}>
              Seçimler hemen uygulanır; arama yazmayı bırakınca. Filtreler adres satırında durur
              (paylaşılabilir).
            </p>
            <div className={local.filterActions}>
              <button type="submit">Uygula</button>
              {activeCount > 0 ? <Link href={PATH}>Tümünü temizle</Link> : null}
            </div>
          </div>
        </ProductFilterForm>

        <ActiveFilters state={state} options={options} />

        <PendingRegion label="Ürün listesi">
          <Suspense fallback={<TableSkeleton />}>
            <ProductResults actor={actor} params={params} state={state} panelId={panelId} />
          </Suspense>
        </PendingRegion>

        {panelId ? (
          <ProductDrawer
            closeHref={listHref(state, cursor)}
            productId={panelId}
            titleId="urun-paneli-baslik"
          >
            <Suspense fallback={<PanelSkeleton />}>
              <PanelContent actor={actor} productId={panelId} titleId="urun-paneli-baslik" />
            </Suspense>
          </ProductDrawer>
        ) : null}
      </ProductListShell>
    </div>
  );
}

function SelectField({
  label,
  name,
  value,
  children,
}: {
  label: string;
  name: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <label className={styles.filterField}>
      <span className={styles.filterLabel}>{label}</span>
      <select name={name} defaultValue={value}>
        {children}
      </select>
    </label>
  );
}

/* ----------------------------------------------------------------------- */
/* Üst metrikler                                                            */
/* ----------------------------------------------------------------------- */

const SECONDARY: { key: ProductQualityFilter; label: string; href: FilterState }[] = [
  { key: "no_image", label: "Görselsiz", href: { gorsel: "without" } },
  { key: "no_price", label: "Fiyatsız", href: { fiyat: "none" } },
  { key: "foreign_only", label: "Yalnız yurt dışı fiyatlı", href: { fiyat: "foreign_only" } },
  { key: "stale_price", label: "Fiyat özeti 7+ gün değişmedi", href: { guncellik: "stale" } },
  { key: "no_offers", label: "Aktif mağazası yok", href: { kalite: "no_offers" } },
];

async function ProductStats({ actor, state }: { actor: AdminActor; state: FilterState }) {
  let counts: Awaited<ReturnType<typeof catalogCounts>>;
  try {
    counts = await catalogCounts(actor);
  } catch {
    return (
      <ErrorNotice>
        Katalog sayıları şu an hesaplanamadı (zaman aşımı olabilir). Liste ve filtreler çalışır.
      </ErrorNotice>
    );
  }
  const { quality, classification } = counts;
  const categorized = quality.total - quality.no_category;
  const branded = quality.total - quality.no_brand;
  const cls = classification;

  return (
    <section className={styles.pageHeader} aria-label="Katalog durumu">
      <div className={local.metrics}>
        <Metric label="Toplam ürün (yayında)" value={formatCount(quality.total)}>
          <span className={local.metricNote}>Taslak ve beklemedeki kaynak ilanları hariç</span>
        </Metric>
        <CoverageMetric
          label="Kategorilendirilen"
          part={categorized}
          whole={quality.total}
          missingLabel="kategorisiz"
          missing={quality.no_category}
          href={listHref({ kategori: UNASSIGNED })}
        />
        <CoverageMetric
          label="Markası belirlenen"
          part={branded}
          whole={quality.total}
          missingLabel="markasız"
          missing={quality.no_brand}
          href={listHref({ marka: UNASSIGNED })}
        />
        <Metric
          label="Sınıflandırma: bekleyen"
          value={formatCount(cls.pending)}
          href="/yonetim/katalog/siniflandirma"
        >
          <span className={local.metricNote}>
            {cls.ruleVersion === null
              ? "Sınıflandırma henüz çalışmadı"
              : `İncelemede ${formatCount(cls.review)} · hata ${formatCount(cls.errors)} · kural v${cls.ruleVersion}`}
          </span>
          <span className={local.metricNote}>
            {cls.completedAt
              ? `Tarama tamamlandı: ${formatDateOrDash(cls.completedAt)}`
              : cls.lastRunAt
                ? `Son ilerleme: ${formatDateOrDash(cls.lastRunAt)} (tamamlanmadı)`
                : null}
          </span>
        </Metric>
      </div>
      <ul className={local.secondary} aria-label="Eksik veri">
        {SECONDARY.map((item) => {
          const active = Object.entries(item.href).every(
            ([key, value]) => state[key as ProductFilterKey] === value,
          );
          return (
            <li key={item.key}>
              <Link
                href={listHref(item.href)}
                className={`${local.chip} ${active ? local.chipActive : ""}`}
                aria-current={active ? "true" : undefined}
                title={QUALITY_LABELS[item.key]}
              >
                {item.label}
                <span className={local.chipValue}>{formatCount(quality[item.key])}</span>
              </Link>
            </li>
          );
        })}
        <li>
          <Link
            href={listHref({ siniflandirma: "error" })}
            className={`${local.chip} ${cls.errors > 0 ? local.chipWarn : ""} ${
              state.siniflandirma === "error" ? local.chipActive : ""
            }`}
          >
            Sınıflandırma hataları
            <span className={local.chipValue}>{formatCount(cls.errors)}</span>
          </Link>
        </li>
      </ul>
      <p className={local.statsFoot}>
        {`Sayılar yayındaki ürünlerin tam sayımıdır; en fazla 2 dakika önce ölçüldü (${formatDateOrDash(counts.measuredAt)}). “Fiyat özeti” mağaza fiyatının değil, özetin son değiştiği anı ölçer.`}
      </p>
    </section>
  );
}

function Metric({
  label,
  value,
  href,
  children,
}: {
  label: string;
  value: string;
  href?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <span className={local.metricLabel}>{label}</span>
      <span className={local.metricValueRow}>
        <span className={local.metricValue}>{value}</span>
      </span>
      {children}
    </>
  );
  return href ? (
    <Link href={href} className={local.metric}>
      {body}
    </Link>
  ) : (
    <div className={local.metric}>{body}</div>
  );
}

function CoverageMetric({
  label,
  part,
  whole,
  missing,
  missingLabel,
  href,
}: {
  label: string;
  part: number;
  whole: number;
  missing: number;
  missingLabel: string;
  href: string;
}) {
  const ratio = whole > 0 ? part / whole : 0;
  return (
    <Link href={href} className={local.metric}>
      <span className={local.metricLabel}>{label}</span>
      <span className={local.metricValueRow}>
        <span className={local.metricValue}>{formatCount(part)}</span>
        <span className={local.metricPercent}>{formatPercent(part, whole)}</span>
      </span>
      <span
        className={local.bar}
        role="progressbar"
        aria-label={`${label} oranı`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <span className={local.barFill} style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </span>
      <span
        className={local.metricNote}
      >{`${formatCount(missing)} ${missingLabel} → listele`}</span>
    </Link>
  );
}

function StatsSkeleton() {
  return (
    <section className={local.metrics} aria-busy="true" aria-label="Katalog durumu yükleniyor">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={local.metric}>
          <Skeleton width="60%" />
          <Skeleton variant="value" width="40%" />
          <Skeleton width="80%" />
        </div>
      ))}
    </section>
  );
}

/* ----------------------------------------------------------------------- */
/* Etkin filtreler                                                          */
/* ----------------------------------------------------------------------- */

function ActiveFilters({
  state,
  options,
}: {
  state: FilterState;
  options: Awaited<ReturnType<typeof listProductFilterOptions>>;
}) {
  const label = (key: ProductFilterKey, value: string): string => {
    switch (key) {
      case "q":
        return `Arama: ${value}`;
      case "durum":
        return `Durum: ${STATE_LABELS[value as keyof typeof STATE_LABELS] ?? value}`;
      case "magaza":
        return `Mağaza: ${options.merchants.find((m) => m.slug === value)?.name ?? value}`;
      case "marka":
        return value === UNASSIGNED ? "Markasız" : `Marka: ${value}`;
      case "kategori":
        return value === UNASSIGNED ? "Kategorisiz" : `Kategori: ${value}`;
      case "siniflandirma":
        return `Sınıflandırma: ${CLASSIFICATION_FILTER_LABELS[value as keyof typeof CLASSIFICATION_FILTER_LABELS]}`;
      case "guven":
        return `Güven: ${CONFIDENCE_LABELS[value as keyof typeof CONFIDENCE_LABELS]}`;
      case "fiyat":
        return PRICE_LABELS[value as keyof typeof PRICE_LABELS];
      case "gorsel":
        return IMAGE_LABELS[value as keyof typeof IMAGE_LABELS];
      case "guncellik":
        return `Fiyat özeti: ${FRESHNESS_LABELS[value as keyof typeof FRESHNESS_LABELS]}`;
      case "kalite":
        return `Kalite: ${QUALITY_LABELS[value as ProductQualityFilter] ?? value}`;
      case "sorun":
        return isProductIssueFilter(value) ? ISSUE_LABELS[value] : value;
    }
  };
  const entries = (Object.entries(state) as [ProductFilterKey, string | undefined][]).filter(
    ([key, value]) => value && !(key === "durum" && value === "published"),
  );
  if (entries.length === 0) return null;
  return (
    <ul className={local.activeFilters} aria-label="Etkin filtreler">
      {entries.map(([key, value]) => (
        <li key={key}>
          <Link
            href={listHref(without(state, key))}
            className={local.activeFilter}
            aria-label={`${label(key, value as string)} filtresini kaldır`}
          >
            {label(key, value as string)}
            <span aria-hidden="true">×</span>
          </Link>
        </li>
      ))}
      {state.sorun ? (
        <li>
          <Link href="/yonetim/katalog/kalite">Katalog kalitesi</Link>
        </li>
      ) : null}
    </ul>
  );
}

/* ----------------------------------------------------------------------- */
/* Tablo                                                                    */
/* ----------------------------------------------------------------------- */

async function ProductResults({
  actor,
  params,
  state,
  panelId,
}: {
  actor: AdminActor;
  params: ProductListParams;
  state: FilterState;
  panelId: number | undefined;
}) {
  const { filter } = parseProductListParams(params);
  let result: Awaited<ReturnType<typeof searchProducts>>;
  try {
    result = await searchProducts(getDatabase(), actor, filter);
  } catch {
    return (
      <ErrorNotice>
        Liste zaman sınırında yüklenemedi. Filtreyi daraltın (ör. mağaza ya da yayın durumu) ve
        yeniden deneyin.
      </ErrorNotice>
    );
  }
  const cursor = { once: params.once, sonra: params.sonra, sayfa: params.sayfa };

  if (result.rows.length === 0) {
    return (
      <EmptyPanel
        title="Bu filtrelere uyan ürün yok."
        description="Filtreleri gevşetin ya da yayın durumunu “Tümü” seçin. Taslaklar kimlik, slug ya da kaynak kimliğiyle bulunur."
        action={<Link href={PATH}>Filtreleri temizle</Link>}
      />
    );
  }

  return (
    <>
      <div className={local.resultsHead}>
        <span>
          {`${formatCount(result.rows.length)} ürün gösteriliyor · en yeni önce`}
          {result.hasNext ? " · devamı var" : ""}
        </span>
        <span>Toplam sayılmaz (milyonlarca satırda her sayfada sayım pahalıdır).</span>
      </div>
      <div className={local.tableScroll}>
        <table className={local.table}>
          <thead>
            <tr>
              <th scope="col" className={local.thumbCell}>
                <span className={local.srOnly}>Görsel</span>
              </th>
              <th scope="col">Ürün</th>
              <th scope="col">Mağaza</th>
              <th scope="col">Marka / kategori</th>
              <th scope="col" className={local.num}>
                En düşük fiyat
              </th>
              <th scope="col">Sınıflandırma</th>
              <th scope="col">Yayın</th>
              <th scope="col" className={local.hideMd}>
                Fiyat özeti
              </th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => {
              const href = listHref(state, { ...cursor, urun: row.id });
              const merchants = result.merchants.get(row.id) ?? [];
              const extra = row.offerCount + row.foreignOfferCount - merchants.length;
              const pub = publicationBadge(row.publicationState);
              const cls = classificationBadge(row.classification?.state ?? null);
              return (
                <tr key={row.id} className={row.id === panelId ? local.rowSelected : undefined}>
                  <td className={local.thumbCell}>
                    <ProductThumb
                      src={row.imageUrl}
                      size={44}
                      className={local.thumb}
                      emptyClassName={local.thumbEmpty}
                    />
                  </td>
                  <td className={local.productCell} data-label="Ürün">
                    <ProductRowLink
                      href={href}
                      productId={row.id}
                      className={local.title}
                      title={row.title}
                    >
                      {row.title}
                    </ProductRowLink>
                    <span className={local.sub}>
                      {`#${row.id}`}
                      {row.gtin ? ` · GTIN ${row.gtin}` : ""}
                    </span>
                  </td>
                  <td data-label="Mağaza">
                    <span className={local.cellStack}>
                      {merchants.length > 0 ? (
                        <span className={local.clip}>
                          {merchants.map((m) => m.name).join(", ")}
                          {extra > 0 ? <span className={local.muted}>{` +${extra}`}</span> : null}
                        </span>
                      ) : (
                        <span className={local.missing}>aktif teklif yok</span>
                      )}
                      {/* Eski "Mağaza (stokta)" sütununun sayıları (fiyat özeti, TRY). */}
                      {row.offerCount > 0 ? (
                        <span className={local.muted}>
                          {`${row.offerCount} TL mağaza · ${row.inStockCount} stokta`}
                        </span>
                      ) : null}
                      {row.sourceMerchant &&
                      !merchants.some((m) => m.slug === row.sourceMerchant?.slug) ? (
                        <span className={local.muted}>{`kaynak: ${row.sourceMerchant.name}`}</span>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Marka / kategori">
                    <span className={local.cellStack}>
                      {row.brandName ? (
                        <span className={local.clip}>{row.brandName}</span>
                      ) : (
                        <span className={local.missing}>markasız</span>
                      )}
                      {row.categoryPath ? (
                        <span className={`${local.muted} ${local.clip}`} title={row.categoryPath}>
                          {shortCategory(row.categoryPath)}
                        </span>
                      ) : (
                        <span className={local.missing}>kategorisiz</span>
                      )}
                    </span>
                  </td>
                  <td className={local.num} data-label="En düşük fiyat">
                    <span className={local.cellStack}>
                      <span>{row.minPrice !== null ? formatKurus(row.minPrice) : "—"}</span>
                      {row.foreignPrices.length > 0 ? (
                        <span className={local.muted}>
                          {`yurt dışı ${formatForeignPrices(row.foreignPrices)}`}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Sınıflandırma">
                    <span className={local.badges}>
                      <StatusBadge tone={cls.tone}>{cls.label}</StatusBadge>
                      {row.classification ? (
                        <StatusBadge tone={confidenceTone(row.classification.confidence)}>
                          {`güven ${row.classification.confidence}`}
                        </StatusBadge>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Yayın">
                    <StatusBadge tone={pub.tone}>{pub.label}</StatusBadge>
                  </td>
                  <td className={local.hideMd} data-label="Fiyat özeti">
                    <span className={`${local.muted} ${local.nowrap}`}>
                      {formatDateOrDash(row.priceUpdatedAt)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager
        first={result.hasPrev ? listHref(state) : null}
        prev={
          result.prevAfter !== null
            ? listHref(state, { sonra: result.prevAfter })
            : result.page > 1
              ? listHref(state, { sayfa: result.page - 1 })
              : null
        }
        next={result.nextBefore !== null ? listHref(state, { once: result.nextBefore }) : null}
      />
    </>
  );
}

function TableSkeleton() {
  return (
    <div className={local.tableScroll} aria-busy="true">
      <table className={local.table}>
        <tbody>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <tr key={i}>
              <td className={local.thumbCell}>
                <span className={local.thumbEmpty} />
              </td>
              <td>
                <Skeleton width="70%" />
                <Skeleton width="30%" />
              </td>
              <td>
                <Skeleton width="60%" />
              </td>
              <td>
                <Skeleton width="50%" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Sağ panel                                                                */
/* ----------------------------------------------------------------------- */

async function PanelContent({
  actor,
  productId,
  titleId,
}: {
  actor: AdminActor;
  productId: number;
  titleId: string;
}) {
  let panel: Awaited<ReturnType<typeof getProductPanel>>;
  try {
    panel = await getProductPanel(getDatabase(), actor, productId);
  } catch {
    return (
      <>
        <h2 id={titleId} tabIndex={-1} className={local.panelTitle}>
          Ürün yüklenemedi
        </h2>
        <ErrorNotice>Ürün ayrıntısı zaman sınırında okunamadı. Yeniden deneyin.</ErrorNotice>
      </>
    );
  }
  if (!panel) {
    return (
      <>
        <h2 id={titleId} tabIndex={-1} className={local.panelTitle}>
          Ürün bulunamadı
        </h2>
        <p className={styles.muted}>{`#${productId} kimlikli ürün yok ya da silinmiş.`}</p>
      </>
    );
  }
  return <ProductPanelView panel={panel} titleId={titleId} />;
}

function PanelSkeleton() {
  return (
    <div aria-busy="true" className={local.panelHero}>
      <span className={local.panelImageEmpty} />
      <div>
        <Skeleton variant="title" width="80%" />
        <Skeleton width="50%" />
      </div>
    </div>
  );
}
