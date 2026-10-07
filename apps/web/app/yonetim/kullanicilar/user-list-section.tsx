import {
  USER_LIST_ANALYTICS,
  USER_LIST_PROVIDERS,
  USER_LIST_ROLES,
  type UserListPage,
} from "@arilla/core";
import Link from "next/link";
import styles from "../admin.module.css";
import { Pager, Section } from "../admin-ui.tsx";
import {
  earlyAccessStatusLabel,
  formatCounterSince,
  formatDateOrDash,
  formatDateTime,
  hrefWith,
  listAnalyticsLabel,
  roleLabel,
  signupProviderLabel,
} from "../format.ts";

const BASE = "/yonetim/kullanicilar";

/**
 * Adres satırı parametreleri Türkçe; değerler İngilizce enum. Core her
 * değeri allowlist ile yeniden doğrular, burada yalnızca eşlenir.
 */
export const LIST_QUERY_KEYS = {
  sort: "sirala",
  cursor: "imlec",
  provider: "yontem",
  role: "rol",
  earlyAccess: "erken",
  analytics: "analitik",
  createdFrom: "kayit_bas",
  createdTo: "kayit_bit",
  lastActiveFrom: "aktif_bas",
  lastActiveTo: "aktif_bit",
} as const;

export type ListSearchParams = Partial<
  Record<(typeof LIST_QUERY_KEYS)[keyof typeof LIST_QUERY_KEYS], string | string[]>
>;

/** Tek değer; dizi gelirse (aynı anahtar iki kez) yok sayılır. */
export function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function shortId(publicId: string): string {
  return publicId.slice(0, 8);
}

export function UserListSection({ page }: { page: UserListPage }) {
  const { filters, sort } = page;
  // İmleç dışındaki durum: filtre ve sıralama sayfalar arasında korunur.
  const state: Record<string, string | undefined> = {
    [LIST_QUERY_KEYS.sort]: sort === "created" ? undefined : sort,
    [LIST_QUERY_KEYS.provider]: filters.provider,
    [LIST_QUERY_KEYS.role]: filters.role,
    [LIST_QUERY_KEYS.earlyAccess]: filters.earlyAccess,
    [LIST_QUERY_KEYS.analytics]: filters.analytics,
    [LIST_QUERY_KEYS.createdFrom]: filters.createdFrom,
    [LIST_QUERY_KEYS.createdTo]: filters.createdTo,
    [LIST_QUERY_KEYS.lastActiveFrom]: filters.lastActiveFrom,
    [LIST_QUERY_KEYS.lastActiveTo]: filters.lastActiveTo,
  };
  const pageHref = (cursor: string | null) =>
    cursor ? hrefWith(BASE, { ...state, [LIST_QUERY_KEYS.cursor]: cursor }) : null;
  const hasFilters = Object.values(state).some(Boolean);

  return (
    <Section id="liste" title="Kullanıcı listesi">
      <p className={styles.muted}>
        Sayfa başına 50 hesap; toplam sayı gösterilmez. E-posta maskelidir. Liste görüntüleme
        denetim kaydına yazılır (yalnızca kullanılan filtrelerin adları).
      </p>
      <form action={BASE} method="get" className={styles.filters} aria-label="Listeyi filtrele">
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Sıralama</span>
          <select name={LIST_QUERY_KEYS.sort} defaultValue={sort}>
            <option value="created">Kayıt tarihi</option>
            <option value="last_active">Son aktif</option>
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Kayıt yöntemi</span>
          <select name={LIST_QUERY_KEYS.provider} defaultValue={filters.provider ?? ""}>
            <option value="">Tümü</option>
            {USER_LIST_PROVIDERS.map((value) => (
              <option key={value} value={value}>
                {signupProviderLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Rol</span>
          <select name={LIST_QUERY_KEYS.role} defaultValue={filters.role ?? ""}>
            <option value="">Tümü</option>
            {USER_LIST_ROLES.map((value) => (
              <option key={value} value={value}>
                {roleLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Erken erişim</span>
          <select name={LIST_QUERY_KEYS.earlyAccess} defaultValue={filters.earlyAccess ?? ""}>
            <option value="">Tümü</option>
            <option value="yes">Listede</option>
            <option value="no">Listede değil</option>
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Analitik rızası</span>
          <select name={LIST_QUERY_KEYS.analytics} defaultValue={filters.analytics ?? ""}>
            <option value="">Tümü</option>
            {USER_LIST_ANALYTICS.map((value) => (
              <option key={value} value={value}>
                {listAnalyticsLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Kayıt (başlangıç)</span>
          <input
            type="date"
            name={LIST_QUERY_KEYS.createdFrom}
            defaultValue={filters.createdFrom}
          />
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Kayıt (bitiş)</span>
          <input type="date" name={LIST_QUERY_KEYS.createdTo} defaultValue={filters.createdTo} />
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Son aktif (başlangıç)</span>
          <input
            type="date"
            name={LIST_QUERY_KEYS.lastActiveFrom}
            defaultValue={filters.lastActiveFrom}
          />
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Son aktif (bitiş)</span>
          <input
            type="date"
            name={LIST_QUERY_KEYS.lastActiveTo}
            defaultValue={filters.lastActiveTo}
          />
        </label>
        <button type="submit">Filtrele</button>
        {hasFilters ? <Link href={BASE}>Temizle</Link> : null}
      </form>
      {sort === "last_active" ? (
        <p className={styles.meta}>
          Son aktif sıralamasında yalnızca aktifliği kaydedilmiş hesaplar görünür.
        </p>
      ) : null}

      {page.rows.length === 0 ? (
        <p className={styles.muted}>Bu filtreye uyan hesap yok.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Hesap</th>
                <th scope="col">Kayıt yöntemi</th>
                <th scope="col">Rol</th>
                <th scope="col">Erken erişim</th>
                <th scope="col">Kayıt</th>
                <th scope="col">Son aktif</th>
                <th scope="col">Giriş sayısı</th>
                <th scope="col">Analitik rızası</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.publicId}>
                  <td>
                    <Link href={`${BASE}/${row.publicId}`} className={styles.mono}>
                      {shortId(row.publicId)}
                    </Link>
                    <div className={styles.meta}>{row.emailMasked ?? "E-posta yok"}</div>
                  </td>
                  <td>{signupProviderLabel(row.signupProvider)}</td>
                  <td>{roleLabel(row.role)}</td>
                  <td>
                    {row.earlyAccess ? earlyAccessStatusLabel(row.earlyAccess.status) : "Hayır"}
                  </td>
                  <td>{formatDateTime(row.createdAt)}</td>
                  <td>
                    {row.lastActiveAt ? formatDateTime(row.lastActiveAt) : "Bilinmiyor"}
                    {row.lastSignInAt ? (
                      <div className={styles.meta}>
                        Son giriş {formatDateOrDash(row.lastSignInAt)}
                        {row.lastSignInDerived ? (
                          <span className={styles.tag}>türetilmiş</span>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td>{formatCounterSince(row.signInCount, row.serviceCountersSince)}</td>
                  <td>{listAnalyticsLabel(row.analyticsConsent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        first={page.prevCursor ? hrefWith(BASE, state) : null}
        prev={pageHref(page.prevCursor)}
        next={pageHref(page.nextCursor)}
      />
    </Section>
  );
}
