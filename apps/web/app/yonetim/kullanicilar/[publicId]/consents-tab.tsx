import type { ConsentKindState, UserConsentsView } from "@arilla/core";
import styles from "../../admin.module.css";
import { Pager, Section } from "../../admin-ui.tsx";
import {
  consentKindLabel,
  consentSourceLabel,
  consentStatusLabel,
  formatDateOrDash,
  formatDateTime,
} from "../../format.ts";
import type { TabPaging } from "./activity-tabs.tsx";

/**
 * İzinler sekmesi (`users.read`, karar 0049 §6). Durum satırlardan türetilir
 * (kabul / ret / geri alındı / kayıt yok). Sürüm bilgisi olmayan eski
 * satırlar GEÇERLİDİR; yalnızca "sürümsüz kayıt" etiketi alır. Aydınlatma
 * metni kaydı bir rıza değildir, ayrı gösterilir. IP hiçbir yerde yok.
 */
function StateTable({ caption, states }: { caption: string; states: ConsentKindState[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className={styles.meta}>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Tür</th>
            <th scope="col">Durum</th>
            <th scope="col">Son karar</th>
            <th scope="col">Kaynak</th>
            <th scope="col">Metin sürümü</th>
          </tr>
        </thead>
        <tbody>
          {states.map((state) => (
            <tr key={state.kind}>
              <td>{consentKindLabel(state.kind)}</td>
              <td>{consentStatusLabel(state.status)}</td>
              <td>{formatDateOrDash(state.at)}</td>
              <td>{state.at ? consentSourceLabel(state.source) : "—"}</td>
              <td>
                {state.textVersion ?? "—"}
                {state.versionless ? <span className={styles.tag}>sürümsüz kayıt</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConsentsTab({ view, paging }: { view: UserConsentsView; paging: TabPaging }) {
  return (
    <>
      <Section id="rizalar" title="Rızalar">
        <p className={styles.muted}>
          Güncel durum her tür için en son kayıttır. “Kayıt yok” izin yok demektir. “Sürümsüz kayıt”
          etiketi yalnızca bilgidir; kararı geçersiz kılmaz.
        </p>
        <StateTable caption="Hesap izinleri" states={view.account} />
        <StateTable
          caption="Çerez tercihleri (girişliyken verilen kararlar)"
          states={view.cookies}
        />
      </Section>

      <Section id="aydinlatma" title="Aydınlatma metni">
        <p className={styles.muted}>
          Bu bir rıza değildir: kullanıcıya hangi aydınlatma metni sürümünün gösterildiğinin
          kaydıdır. Güncel sürüm: {view.currentPrivacyNoticeVersion}.
        </p>
        {view.privacyNotice ? (
          <p>
            Son gösterilen sürüm {view.privacyNotice.textVersion ?? "bilinmiyor"} ·{" "}
            {formatDateTime(view.privacyNotice.shownAt)}
            {view.privacyNotice.isCurrent ? null : (
              <span className={styles.tag}>güncel sürüm değil</span>
            )}
          </p>
        ) : (
          <p className={styles.muted}>Kayıt yok.</p>
        )}
      </Section>

      <Section id="riza-gecmisi" title="Geçmiş">
        {view.history.length === 0 ? (
          <p className={styles.muted}>Kayıt yok.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Zaman</th>
                  <th scope="col">Tür</th>
                  <th scope="col">Karar</th>
                  <th scope="col">Kaynak</th>
                  <th scope="col">Metin sürümü</th>
                </tr>
              </thead>
              <tbody>
                {view.history.map((row) => (
                  <tr key={row.key}>
                    <td>{formatDateTime(row.grantedAt)}</td>
                    <td>{consentKindLabel(row.kind)}</td>
                    <td>
                      {row.kind === "privacy_notice"
                        ? "Gösterildi"
                        : row.granted
                          ? "Verdi"
                          : "Vermedi / geri aldı"}
                    </td>
                    <td>{consentSourceLabel(row.source)}</td>
                    <td>
                      {row.textVersion ?? "—"}
                      {row.versionless ? <span className={styles.tag}>sürümsüz kayıt</span> : null}
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
    </>
  );
}
