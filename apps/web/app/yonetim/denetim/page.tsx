import { AUDIT_TARGET_TYPES, isAuditTargetType, listAdminEvents } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { ADMIN_ACTIONS, actionLabel, formatDateTime, hrefWith, positiveInt } from "../format.ts";

interface DenetimSearchParams {
  eylem?: string;
  /** Aktör hesap kimliği (iç sayısal id). */
  kisi?: string;
  hedef?: string;
  hedefId?: string;
  once?: string;
}

const TARGET_TYPE_LABELS: Record<string, string> = {
  match_candidate: "Eşleştirme adayı",
  lexicon: "Sözlük satırı",
  merchant: "Mağaza",
  app_user: "Hesap",
  marketing_campaign: "E-posta kampanyası",
  capability: "Yetenek",
};

/** Hedef kimliği: sayısal id ya da yetenek adı gibi kısa, düz değer. */
function parseTargetId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^[a-z0-9._-]{1,64}$/i.test(trimmed) ? trimmed : undefined;
}

function changeText(value: unknown): string {
  return value === null || value === undefined ? "—" : JSON.stringify(value, null, 1);
}

/** docs/decisions/0039 madde 5: yalnızca `audit.read` (yönetici). Değiştirilemez kayıt. */
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<DenetimSearchParams>;
}) {
  const { actor } = await requireCapability("audit.read");
  const params = await searchParams;
  const action = params.eylem && ADMIN_ACTIONS.includes(params.eylem) ? params.eylem : undefined;
  const actorUserId = positiveInt(params.kisi);
  const targetType = isAuditTargetType(params.hedef) ? params.hedef : undefined;
  // Hedef kimliği yalnızca bir hedef türüyle anlamlıdır.
  const targetId = targetType ? parseTargetId(params.hedefId) : undefined;
  const beforeId = positiveInt(params.once);

  const page = await listAdminEvents(getDatabase(), actor, {
    action,
    actorUserId,
    targetType,
    targetId,
    beforeId,
  });

  const base = { eylem: action, kisi: actorUserId, hedef: targetType, hedefId: targetId };
  const filtered = Boolean(action || actorUserId || targetType || targetId || beforeId);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Denetim kaydı</h1>
        <p className={styles.muted}>
          Yönetim ekranlarındaki her değişiklik burada, değiştirilemez olarak tutulur. Yeniden
          eskiye. Kişiye ya da hedefin geçmişine tıklayınca kayıt ona göre süzülür.
        </p>
      </header>

      <form action="/yonetim/denetim" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Eylem</span>
          <select name="eylem" defaultValue={action ?? ""}>
            <option value="">Tümü</option>
            {ADMIN_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Hedef türü</span>
          <select name="hedef" defaultValue={targetType ?? ""}>
            <option value="">Tümü</option>
            {AUDIT_TARGET_TYPES.map((t) => (
              <option key={t} value={t}>
                {TARGET_TYPE_LABELS[t] ?? t}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Hedef kimliği</span>
          <input type="text" name="hedefId" defaultValue={targetId ?? ""} maxLength={64} />
        </label>
        {actorUserId ? <input type="hidden" name="kisi" value={actorUserId} /> : null}
        <button type="submit">Filtrele</button>
        {filtered ? <Link href="/yonetim/denetim">Temizle</Link> : null}
      </form>

      {actorUserId ? (
        <p className={styles.muted}>
          {`Yalnızca hesap #${actorUserId} tarafından yapılanlar. `}
          <Link href={hrefWith("/yonetim/denetim", { ...base, kisi: undefined })}>
            Kişi filtresini kaldır
          </Link>
        </p>
      ) : null}

      {page.rows.length === 0 ? (
        <EmptyState title="Kayıt yok." description="Bu filtreye uyan bir değişiklik yapılmamış." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Zaman</th>
                <th scope="col">Kişi</th>
                <th scope="col">Eylem</th>
                <th scope="col">Hedef</th>
                <th scope="col">Gerekçe</th>
                <th scope="col">Önce</th>
                <th scope="col">Sonra</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.createdAt)}</td>
                  <td>
                    {row.actorUserId !== null ? (
                      <Link
                        href={hrefWith("/yonetim/denetim", { kisi: row.actorUserId })}
                        title="Bu kişinin kayıtları"
                      >
                        {row.actorLabel}
                      </Link>
                    ) : (
                      row.actorLabel
                    )}
                    <br />
                    <span className={styles.meta}>{row.actorRole}</span>
                  </td>
                  <td>{actionLabel(row.action)}</td>
                  <td>
                    {row.target.href ? (
                      <Link href={row.target.href}>{row.target.label}</Link>
                    ) : (
                      row.target.label
                    )}
                    <br />
                    <Link
                      className={styles.meta}
                      href={hrefWith("/yonetim/denetim", {
                        hedef: row.targetType,
                        hedefId: row.targetId,
                      })}
                      title="Bu hedefin tüm kayıtları"
                    >
                      {`${TARGET_TYPE_LABELS[row.targetType] ?? row.targetType} · geçmişi`}
                    </Link>
                  </td>
                  <td>{row.reason ?? "—"}</td>
                  <td className={styles.mono}>{changeText(row.before)}</td>
                  <td className={styles.mono}>{changeText(row.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav className={styles.pager} aria-label="Sayfalar">
        {beforeId ? <Link href={hrefWith("/yonetim/denetim", base)}>En yeniye dön</Link> : null}
        {page.nextBeforeId ? (
          <Link href={hrefWith("/yonetim/denetim", { ...base, once: page.nextBeforeId })}>
            Daha eski kayıtlar
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
