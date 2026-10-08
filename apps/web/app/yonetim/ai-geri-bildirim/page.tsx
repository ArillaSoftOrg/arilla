import {
  getChatFeedbackSummary,
  isChatFeedbackDay,
  isChatFeedbackReason,
  listChatFeedback,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { requireCapability } from "../../lib/dal.ts";
import { CHAT_COPY } from "../../sohbet/chat-copy.ts";
import styles from "../admin.module.css";
import { PageHeader, Section, Tile } from "../admin-ui.tsx";
import { formatCount, formatDateTime, hrefWith, positiveInt } from "../format.ts";
import { percent, reasonLabel } from "./labels.ts";

interface SearchParams {
  baslangic?: string;
  bitis?: string;
  oy?: string;
  neden?: string;
  yorum?: string;
  once?: string;
}

const PATH = "/yonetim/ai-geri-bildirim";

/**
 * AI sohbet geri bildirimi (karar 0079): oy dağılımı, nedenler, yorumlar ve eğilim.
 * Yalnızca `feedback.chat.read` (yönetici). Sohbet metni gösterilmez; her görüntüleme
 * denetime yazılır (yorum ve neden yazılmaz).
 */
export default async function ChatFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { actor } = await requireCapability("feedback.chat.read");
  const params = await searchParams;
  const from = isChatFeedbackDay(params.baslangic) ? params.baslangic : undefined;
  const to = isChatFeedbackDay(params.bitis) ? params.bitis : undefined;
  const helpful = params.oy === "olumlu" ? true : params.oy === "olumsuz" ? false : undefined;
  const reason = isChatFeedbackReason(params.neden) ? params.neden : undefined;
  const hasComment = params.yorum === "1";
  const beforeId = positiveInt(params.once);

  const db = getDatabase();
  const filter = { from, to, helpful, reason, hasComment, beforeId };
  const [summary, page] = await Promise.all([
    getChatFeedbackSummary(db, actor, filter),
    listChatFeedback(db, actor, filter),
  ]);
  const base = {
    baslangic: from,
    bitis: to,
    oy: params.oy === "olumlu" || params.oy === "olumsuz" ? params.oy : undefined,
    neden: reason,
    yorum: hasComment ? "1" : undefined,
  };
  const filtered = Boolean(from || to || helpful !== undefined || reason || hasComment || beforeId);
  const { totals, participation, last7, last30 } = summary;

  return (
    <div className={styles.page}>
      <PageHeader title="AI geri bildirimleri">
        <p className={styles.muted}>
          Sohbet yanıtlarına verilen evet/hayır oyları, nedenler ve yorumlar. Sohbet metni bu
          ekranda gösterilmez. Yorumlar kişisel veri içerebilir; bu ekranın her görüntülenmesi
          denetim kaydına yazılır. Geri bildirim modeli otomatik eğitmez, yalnızca kalite analizi
          içindir.
        </p>
      </PageHeader>

      <form action={PATH} method="get" className={styles.filters}>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Başlangıç</span>
          <input type="date" name="baslangic" defaultValue={summary.range.from} />
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Bitiş</span>
          <input type="date" name="bitis" defaultValue={summary.range.to} />
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Oy</span>
          <select name="oy" defaultValue={base.oy ?? ""}>
            <option value="">Tümü</option>
            <option value="olumlu">Olumlu</option>
            <option value="olumsuz">Olumsuz</option>
          </select>
        </label>
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Neden</span>
          <select name="neden" defaultValue={reason ?? ""}>
            <option value="">Tümü</option>
            {Object.entries(CHAT_COPY.feedbackReasons).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" name="yorum" value="1" defaultChecked={hasComment} /> Yalnızca
          yorumlu olanlar
        </label>
        <button type="submit">Filtrele</button>
        {filtered ? <Link href={PATH}>Temizle</Link> : null}
      </form>

      <Section id="ozet" title={`Özet (${summary.range.from} – ${summary.range.to})`}>
        <div className={styles.tiles}>
          <Tile label="Toplam değerlendirme" value={formatCount(totals.total)} />
          <Tile label="Olumlu" value={formatCount(totals.positive)} />
          <Tile label="Olumsuz" value={formatCount(totals.negative)} />
          <Tile label="Olumlu oran" value={percent(totals.positiveRate)} />
          <Tile
            label="Katılım oranı"
            value={percent(participation.rate)}
            note={`${formatCount(participation.voted)} oy / ${formatCount(participation.votable)} yanıt. Oy yalnızca son sonuç bloklarında sorulduğu için alt sınır göstergesidir.`}
          />
          <Tile label="Yorumlu oy" value={formatCount(totals.withComment)} />
        </div>
        <p className={styles.muted}>
          Özet tarih aralığına göre hesaplanır; oy yönü, neden ve yorum filtreleri yalnızca
          aşağıdaki listeyi daraltır.
        </p>
      </Section>

      <Section id="egilim" title="Eğilim (bugüne göre)">
        <div className={styles.tiles}>
          <Tile
            label="Son 7 gün"
            value={formatCount(last7.total)}
            note={`Olumlu oran ${percent(last7.positiveRate)}`}
          />
          <Tile
            label="Son 30 gün"
            value={formatCount(last30.total)}
            note={`Olumlu oran ${percent(last30.positiveRate)}`}
          />
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.meta}>Günlük değerlendirme sayısı, son 30 gün</caption>
            <thead>
              <tr>
                <th scope="col">Gün</th>
                <th scope="col">Olumlu</th>
                <th scope="col">Olumsuz</th>
              </tr>
            </thead>
            <tbody>
              {[...summary.daily].reverse().map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td>{formatCount(d.positive)}</td>
                  <td>{formatCount(d.negative)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="nedenler" title="Olumsuzluk nedenleri">
        {summary.reasons.length === 0 ? (
          <p className={styles.muted}>Bu aralıkta olumsuz oy yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Neden</th>
                  <th scope="col">Oy</th>
                  <th scope="col">Pay</th>
                </tr>
              </thead>
              <tbody>
                {summary.reasons.map((r) => (
                  <tr key={r.reason}>
                    <td>{reasonLabel(r.reason)}</td>
                    <td>{formatCount(r.count)}</td>
                    <td>{percent(totals.negative > 0 ? r.count / totals.negative : null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="model" title="Model sürümüne göre">
        <p className={styles.muted}>
          Model sürümü oy anında aynı kullanıcının en yakın sohbet çağrısından alınır; kesin bağ
          değil, yaklaşık bir göstergedir.
        </p>
        {summary.models.length === 0 ? (
          <p className={styles.muted}>Veri yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Oy</th>
                  <th scope="col">Olumlu oran</th>
                </tr>
              </thead>
              <tbody>
                {summary.models.map((m) => (
                  <tr key={m.modelVersion ?? "unknown"}>
                    <td>{m.modelVersion ?? "Bilinmiyor"}</td>
                    <td>{formatCount(m.total)}</td>
                    <td>{percent(m.positiveRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="liste" title="Değerlendirmeler">
        {page.rows.length === 0 ? (
          <EmptyState title="Kayıt yok." description="Bu filtreye uyan bir değerlendirme yok." />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Tarih</th>
                  <th scope="col">Oy</th>
                  <th scope="col">Neden</th>
                  <th scope="col">Yorum</th>
                  <th scope="col">Model</th>
                  <th scope="col">Ayrıntı</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row.messageId}>
                    <td>{formatDateTime(row.createdAt)}</td>
                    <td>{row.helpful ? "Olumlu" : "Olumsuz"}</td>
                    <td>{row.reasons.length ? row.reasons.map(reasonLabel).join(", ") : "—"}</td>
                    <td>{row.comment ?? "—"}</td>
                    <td>{row.modelVersion ?? "—"}</td>
                    <td>
                      <Link href={`${PATH}/${row.messageId}`}>Aç</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <nav className={styles.pager} aria-label="Sayfalar">
          {beforeId ? <Link href={hrefWith(PATH, base)}>En yeniye dön</Link> : null}
          {page.nextBeforeId ? (
            <Link href={hrefWith(PATH, { ...base, once: page.nextBeforeId })}>
              Daha eski değerlendirmeler
            </Link>
          ) : null}
        </nav>
      </Section>
    </div>
  );
}
