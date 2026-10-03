import { getFormResults } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState } from "@arilla/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../lib/dal.ts";
import styles from "../../../admin.module.css";
import { Notice, PageHeader, Section, StatusText } from "../../../admin-ui.tsx";
import { formatCount, formatDateTime, positiveInt } from "../../../format.ts";

/**
 * Form sonuçları (docs/decisions/0058): özet sayılar, seçenek dağılımı ve
 * metin yanıtları. Kullanıcı referansı hesabın public kimliğidir (e-posta
 * gösterilmez). Görüntüleme `forms.results_view` olarak denetlenir.
 */
export default async function FormResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await requireCapability("forms.manage");
  const id = positiveInt((await params).id);
  if (!id) notFound();
  const results = await getFormResults(getDatabase(), actor, id);
  if (!results) notFound();

  return (
    <div className={styles.page}>
      <PageHeader title={`Sonuçlar: ${results.title}`}>
        <p className={styles.muted}>
          Durum: <StatusText status={results.status} /> ·{" "}
          <Link href={`/yonetim/formlar/${results.formId}`}>Formu düzenle</Link> ·{" "}
          <Link href="/yonetim/formlar">Tüm formlar</Link>
        </p>
      </PageHeader>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <tbody>
            <tr>
              <th scope="row">Toplam yanıt</th>
              <td className={styles.num}>{formatCount(results.totalResponses)}</td>
            </tr>
            <tr>
              <th scope="row">Giriş yapmış kullanıcıdan</th>
              <td className={styles.num}>{formatCount(results.authenticatedResponses)}</td>
            </tr>
            <tr>
              <th scope="row">Anonim</th>
              <td className={styles.num}>{formatCount(results.anonymousResponses)}</td>
            </tr>
            {results.kind === "onboarding" || results.skipCount > 0 ? (
              <tr>
                <th scope="row">“Şimdilik geç” diyen</th>
                <td className={styles.num}>{formatCount(results.skipCount)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Notice>
        Yalnızca gönderilen (tamamlanan) yanıtlar kaydedilir; yarım bırakılan formlar sayılmaz.
      </Notice>

      {results.totalResponses === 0 ? (
        <EmptyState title="Henüz yanıt yok." description="Yanıtlar geldikçe burada görünür." />
      ) : null}

      {results.questions.map((question, index) => (
        <Section
          key={question.questionId}
          id={`soru-${question.questionId}`}
          title={`${index + 1}. ${question.label}`}
        >
          <p className={styles.meta}>{formatCount(question.answered)} yanıt</p>
          {"options" in question ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Seçenek</th>
                    <th scope="col" className={styles.num}>
                      Sayı
                    </th>
                    <th scope="col" className={styles.num}>
                      Yüzde
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {question.options.map((option) => (
                    <tr key={option.label}>
                      <td>{option.label}</td>
                      <td className={styles.num}>{formatCount(option.count)}</td>
                      <td className={styles.num}>%{option.percent.toLocaleString("tr-TR")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              {question.answers.length === 0 ? (
                <p className={styles.muted}>Yanıt yok.</p>
              ) : (
                <ul className={styles.list}>
                  {question.answers.map((answer) => (
                    <li
                      key={`${answer.submittedAt.getTime()}-${answer.userRef ?? ""}-${answer.text}`}
                    >
                      <p>{answer.text}</p>
                      <p className={styles.meta}>
                        {formatDateTime(answer.submittedAt)} ·{" "}
                        {answer.userRef ? `hesap ${answer.userRef.slice(0, 8)}` : "anonim"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {question.truncated ? (
                <p className={styles.muted}>En yeni 200 yanıt gösteriliyor.</p>
              ) : null}
            </>
          )}
        </Section>
      ))}
    </div>
  );
}
