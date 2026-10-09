import {
  allowedInboxTransitions,
  hasCapability,
  INBOX_PRIORITIES,
  INBOX_STATUSES,
  isInboxCategory,
  isInboxKind,
  isInboxPriority,
  isInboxStatus,
  listInboxMessages,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { FEEDBACK_CATEGORY_LABELS } from "../../geri-bildirim/feedback-copy.ts";
import { CONTACT_CATEGORY_LABELS } from "../../iletisim/contact-copy.ts";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { StatusBadge } from "../admin-ui.tsx";
import {
  formatDateTime,
  hrefWith,
  inboxPriorityLabel,
  inboxStatusLabel,
  positiveInt,
} from "../format.ts";
import inbox from "./page.module.css";
import { InboxTriageClient } from "./triage-client.tsx";

interface MesajlarSearchParams {
  tur?: string;
  konu?: string;
  durum?: string;
  oncelik?: string;
  once?: string;
}

const KIND_LABELS: Record<string, string> = {
  contact: "İletişim",
  feedback: "Geri bildirim",
};

/** Etiketler formların kendi metin dosyalarından: tek kaynak. */
const CATEGORY_LABELS: Record<string, string> = {
  ...FEEDBACK_CATEGORY_LABELS,
  ...CONTACT_CATEGORY_LABELS,
};

/**
 * Yanıt bağlantısı. Adres de kodlanır: doğrulama `?`/`&` içeren bir adresi
 * kabul edebilir (`a@b.co?bcc=...`); kodlanmazsa yöneticinin yanıtına başlık
 * eklenebilirdi.
 */
function replyHref(email: string, subject: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`Re: ${subject}`)}`;
}

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * Gelen kutusu (docs/decisions/0061): `/iletisim` ve `/geri-bildirim`
 * gönderileri, yeniden eskiye. Salt okunur; yanıt e-postayla verilir.
 * Yalnızca `messages.read` (yönetici); her görüntüleme denetime yazılır
 * (içerik, ad ve e-posta yazılmaz).
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<MesajlarSearchParams>;
}) {
  const { user, actor } = await requireCapability("messages.read");
  const canTriage = hasCapability(user.role, "messages.triage");
  const params = await searchParams;
  const kind = isInboxKind(params.tur) ? params.tur : undefined;
  const category = isInboxCategory(params.konu) ? params.konu : undefined;
  const status = isInboxStatus(params.durum) ? params.durum : undefined;
  const priority =
    params.oncelik === "none" || isInboxPriority(params.oncelik) ? params.oncelik : undefined;
  const beforeId = positiveInt(params.once);

  const page = await listInboxMessages(getDatabase(), actor, {
    kind,
    category,
    status,
    priority,
    beforeId,
  });
  const base = { tur: kind, konu: category, durum: status, oncelik: priority };
  const filtered = Boolean(kind || category || status || priority || beforeId);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Gelen kutusu</h1>
        <p className={styles.muted}>
          İletişim formu ve geri bildirim mesajları, yeniden eskiye. Yanıtı mesajdaki e-posta
          adresine yazın. Bu ekranın her görüntülenmesi denetim kaydına yazılır.
        </p>
      </header>

      <form action="/yonetim/mesajlar" method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Tür</span>
          <select name="tur" defaultValue={kind ?? ""}>
            <option value="">Tümü</option>
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Konu</span>
          <select name="konu" defaultValue={category ?? ""}>
            <option value="">Tümü</option>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Durum</span>
          <select name="durum" defaultValue={status ?? ""}>
            <option value="">Tümü</option>
            {INBOX_STATUSES.map((value) => (
              <option key={value} value={value}>
                {inboxStatusLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Öncelik</span>
          <select name="oncelik" defaultValue={priority ?? ""}>
            <option value="">Tümü</option>
            <option value="none">{inboxPriorityLabel(null)}</option>
            {INBOX_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {inboxPriorityLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filtrele</button>
        {filtered ? <Link href="/yonetim/mesajlar">Temizle</Link> : null}
      </form>

      {page.rows.length === 0 ? (
        <EmptyState title="Mesaj yok." description="Bu filtreye uyan bir mesaj gelmemiş." />
      ) : (
        <ol className={inbox.list}>
          {page.rows.map((row) => (
            <li key={row.id} className={inbox.message}>
              <header className={inbox.messageHeader}>
                <h2 className={inbox.subject}>{row.subject}</h2>
                <p className={styles.meta}>
                  {`${KIND_LABELS[row.kind] ?? row.kind} · ${categoryLabel(row.category)} · ${formatDateTime(row.createdAt)} · #${row.id}`}
                </p>
                <p className={styles.row}>
                  <StatusBadge
                    tone={
                      row.status === "new"
                        ? "info"
                        : row.status === "resolved"
                          ? "success"
                          : "neutral"
                    }
                  >
                    {inboxStatusLabel(row.status)}
                  </StatusBadge>
                  <StatusBadge tone={row.priority === "high" ? "warning" : "neutral"}>
                    {`Öncelik: ${inboxPriorityLabel(row.priority)}`}
                  </StatusBadge>
                </p>
              </header>
              <dl className={inbox.sender}>
                <dt>Gönderen</dt>
                <dd>{row.name ?? "—"}</dd>
                <dt>E-posta</dt>
                <dd>
                  {row.email ? (
                    <a href={replyHref(row.email, row.subject)}>{row.email}</a>
                  ) : (
                    "bırakılmadı"
                  )}
                </dd>
                <dt>Hesap</dt>
                <dd>
                  {row.accountPublicId ? (
                    <Link href={`/yonetim/kullanicilar/${row.accountPublicId}`}>hesabı aç</Link>
                  ) : (
                    "giriş yapılmamış"
                  )}
                </dd>
              </dl>
              <p className={inbox.body}>{row.message}</p>
              {canTriage ? (
                <InboxTriageClient
                  messageId={row.id}
                  status={row.status}
                  priority={row.priority}
                  transitions={allowedInboxTransitions(row.status)}
                />
              ) : null}
            </li>
          ))}
        </ol>
      )}

      <nav className={styles.pager} aria-label="Sayfalar">
        {beforeId ? <Link href={hrefWith("/yonetim/mesajlar", base)}>En yeniye dön</Link> : null}
        {page.nextBeforeId ? (
          <Link href={hrefWith("/yonetim/mesajlar", { ...base, once: page.nextBeforeId })}>
            Daha eski mesajlar
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
