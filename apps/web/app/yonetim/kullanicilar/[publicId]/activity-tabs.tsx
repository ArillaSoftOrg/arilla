import type {
  UserActivityView,
  UserAffiliateView,
  UserSearchesView,
  UserSessionsView,
} from "@arilla/core";
import styles from "../../admin.module.css";
import { KeyValues, Pager, Section } from "../../admin-ui.tsx";
import {
  activityKindLabel,
  authEventLabel,
  channelLabel,
  chargeStateLabel,
  clickSurfaceLabel,
  conversionStatusLabel,
  deviceContextLabel,
  formatCount,
  formatCounterSince,
  formatDateOrDash,
  formatDateTime,
  formatKurus,
  refundReasonLabel,
  searchOperationLabel,
  signupProviderLabel,
} from "../../format.ts";

/**
 * Hassas sekmeler (`users.activity.read`, karar 0049 §3). Her görüntüleme
 * `users.view_tab` olarak denetime yazılır (core). Veri sınıfları ayrı
 * tutulur: hizmet/güvenlik (oturum, giriş, hak kaydı), attribution
 * (tıklama) ve rızalı davranışsal analitik (olaylar, sayaçlar).
 */

/** Sekme içi sayfalama: ilk sayfaya dönüş ve "daha eski" imleci. */
export interface TabPaging {
  first: string | null;
  next: (cursor: string | null) => string | null;
}

export function ActivityTab({ view, paging }: { view: UserActivityView; paging: TabPaging }) {
  const { counters } = view;
  const since = counters.analyticsCountersSince;
  return (
    <>
      <Section id="analitik-sayaclar" title="Analitik sayaçları">
        <p className={styles.muted}>
          Yalnızca analitik rızası varken sayılır. Rıza yoksa ya da geri alındıysa sayaçlar
          bilinmiyor görünür; geçmiş uydurulmaz.
        </p>
        <KeyValues
          items={[
            ["Metin araması", formatCounterSince(counters.searchCount, since)],
            ["Ürün görüntüleme", formatCounterSince(counters.productViewCount, since)],
            ["Mağazaya geçiş", formatCounterSince(counters.merchantExitCount, since)],
            [
              "Son arama",
              counters.lastSearchAt ? formatDateTime(counters.lastSearchAt) : "Bilinmiyor",
            ],
          ]}
        />
      </Section>
      <Section id="analitik-olaylar" title="Son olaylar">
        {view.events.length === 0 ? (
          <p className={styles.muted}>Kayıtlı analitik olayı yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Zaman</th>
                  <th scope="col">Olay</th>
                  <th scope="col">Kanal</th>
                  <th scope="col">Ayrıntı</th>
                </tr>
              </thead>
              <tbody>
                {view.events.map((event) => (
                  <tr key={event.key}>
                    <td>{formatDateTime(event.createdAt)}</td>
                    <td>{activityKindLabel(event.kind)}</td>
                    <td>{channelLabel(event.channel)}</td>
                    <td>
                      {event.kind === "search_submitted"
                        ? `${event.queryNorm ?? "sorgu silindi (90 gün)"}${
                            event.resultCount === null
                              ? ""
                              : ` · ${formatCount(event.resultCount)} sonuç`
                          }`
                        : event.kind === "product_viewed"
                          ? (event.product?.title ?? "Ürün artık yok")
                          : (event.merchantName ?? "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          first={paging.first}
          next={paging.next(view.nextCursor)}
          nextLabel="Daha eski olaylar"
        />
      </Section>
    </>
  );
}

export function SessionsTab({ view, paging }: { view: UserSessionsView; paging: TabPaging }) {
  return (
    <>
      <Section id="aktif-oturumlar" title="Aktif oturumlar">
        <p className={styles.muted}>
          Yalnızca kaba cihaz, tarayıcı ve ülke. IP adresi ve tarayıcı kimliği gösterilmez.
        </p>
        <KeyValues items={[["Son görülen bağlam", deviceContextLabel(view.lastContext)]]} />
        {view.activeSessions.length === 0 ? (
          <p className={styles.muted}>Aktif oturum yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Cihaz</th>
                  <th scope="col">Açıldı</th>
                  <th scope="col">Son kullanım</th>
                  <th scope="col">Bitiş</th>
                </tr>
              </thead>
              <tbody>
                {view.activeSessions.map((row) => (
                  <tr
                    key={`${row.createdAt.getTime()}-${row.lastUsedAt.getTime()}-${row.expiresAt.getTime()}`}
                  >
                    <td>{deviceContextLabel(row)}</td>
                    <td>{formatDateTime(row.createdAt)}</td>
                    <td>{formatDateTime(row.lastUsedAt)}</td>
                    <td>{formatDateTime(row.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section id="giris-gecmisi" title="Giriş ve çıkış geçmişi">
        {view.authEvents.length === 0 ? (
          <p className={styles.muted}>
            Kayıt yok. Giriş geçmişi bu özellik açıldıktan sonra tutulmaya başladı.
          </p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Zaman</th>
                  <th scope="col">Olay</th>
                  <th scope="col">Yöntem</th>
                  <th scope="col">Cihaz</th>
                </tr>
              </thead>
              <tbody>
                {view.authEvents.map((row) => (
                  <tr key={row.key}>
                    <td>{formatDateTime(row.createdAt)}</td>
                    <td>{authEventLabel(row.kind)}</td>
                    <td>{row.provider ? signupProviderLabel(row.provider) : "—"}</td>
                    <td>{deviceContextLabel(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          first={paging.first}
          next={paging.next(view.nextCursor)}
          nextLabel="Daha eski kayıtlar"
        />
      </Section>
    </>
  );
}

export function SearchesTab({ view, paging }: { view: UserSearchesView; paging: TabPaging }) {
  return (
    <>
      <Section id="hak-kayitlari" title="Fotoğrafla ve linkle aramalar (hak kaydı)">
        <p className={styles.muted}>
          Hizmet kaydıdır: arama hakkı harcaması ve iadesi. Analitik rızasından bağımsız tutulur.
          {view.chargesTruncated ? " Yalnızca en yeni 50 kayıt gösteriliyor." : ""}
        </p>
        {view.charges.length === 0 ? (
          <p className={styles.muted}>Kayıt yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Tarih</th>
                  <th scope="col">Tür</th>
                  <th scope="col">Durum</th>
                  <th scope="col" className={styles.num}>
                    Hak
                  </th>
                  <th scope="col">Sonuçlandı</th>
                </tr>
              </thead>
              <tbody>
                {view.charges.map((row) => (
                  <tr key={row.key}>
                    <td>{formatDateTime(row.createdAt)}</td>
                    <td>{searchOperationLabel(row.operation)}</td>
                    <td>
                      {chargeStateLabel(row.state)}
                      {row.refundReason ? ` · ${refundReasonLabel(row.refundReason)}` : ""}
                    </td>
                    <td className={styles.num}>{formatCount(row.cost)}</td>
                    <td>{formatDateOrDash(row.finalizedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section id="metin-aramalari" title="Metin aramaları (analitik)">
        <p className={styles.muted}>
          Yalnızca analitik rızası varken kaydedilir. Sorgu metni normalleştirilmiştir ve 90 günde
          silinir. Toplam: {formatCounterSince(view.textSearchCount, view.analyticsCountersSince)}.
        </p>
        {view.textSearches.length === 0 ? (
          <p className={styles.muted}>Kayıt yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Zaman</th>
                  <th scope="col">Sorgu</th>
                  <th scope="col" className={styles.num}>
                    Sonuç
                  </th>
                  <th scope="col">Kanal</th>
                </tr>
              </thead>
              <tbody>
                {view.textSearches.map((row) => (
                  <tr key={row.key}>
                    <td>{formatDateTime(row.createdAt)}</td>
                    <td>{row.queryNorm ?? "Sorgu silindi (90 gün)"}</td>
                    <td className={styles.num}>
                      {row.resultCount === null ? "—" : formatCount(row.resultCount)}
                    </td>
                    <td>{channelLabel(row.channel)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          first={paging.first}
          next={paging.next(view.nextCursor)}
          nextLabel="Daha eski aramalar"
        />
      </Section>
    </>
  );
}

export function AffiliateTab({ view, paging }: { view: UserAffiliateView; paging: TabPaging }) {
  return (
    <Section id="attribution" title="Attribution kaydı">
      <p className={styles.muted}>
        Mağazaya giden bağlantıların attribution kaydıdır; komisyon mutabakatı ve kullanıcı desteği
        içindir. Bu kayıtlardan ilgi alanı ya da segment çıkarılmaz ve analitik sayaçlarına
        eklenmez.
      </p>
      <KeyValues
        items={[
          [
            "Attribution kaydı",
            `${formatCount(view.clickCount)}${view.clickCountCapped ? "+" : ""}`,
          ],
          [
            "Dönüşüm",
            view.conversionsByStatus.length === 0
              ? "Yok"
              : view.conversionsByStatus
                  .map((row) => `${conversionStatusLabel(row.status)} ${formatCount(row.count)}`)
                  .join(" · "),
          ],
        ]}
      />
      {view.clicks.length === 0 ? (
        <p className={styles.muted}>Kayıt yok.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Zaman</th>
                <th scope="col">Mağaza</th>
                <th scope="col">Yüzey</th>
                <th scope="col">Kanal</th>
                <th scope="col" className={styles.num}>
                  Tıklama anı fiyatı
                </th>
                <th scope="col">Dönüşüm</th>
              </tr>
            </thead>
            <tbody>
              {view.clicks.map((row) => (
                <tr key={row.key}>
                  <td>{formatDateTime(row.createdAt)}</td>
                  <td>{row.merchantName}</td>
                  <td>{clickSurfaceLabel(row.surface)}</td>
                  <td>{channelLabel(row.channel)}</td>
                  <td className={styles.num}>{formatKurus(row.priceAtClick)}</td>
                  <td>
                    {row.conversion
                      ? `${conversionStatusLabel(row.conversion.status)} · ${formatDateTime(
                          row.conversion.occurredAt,
                        )}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        first={paging.first}
        next={paging.next(view.nextCursor)}
        nextLabel="Daha eski kayıtlar"
      />
    </Section>
  );
}
