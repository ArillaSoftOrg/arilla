import { listIncompleteForms } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import styles from "./page.module.css";

/**
 * "Tamamlanmamış formlar" (docs/decisions/0058): kullanıcının hedef kitlesine
 * uygun, yayında, tek yanıtlı ve henüz yanıtlamadığı formlar. Onboarding'i
 * "Şimdilik geç" ile atlayan kullanıcı buradan tamamlar. Yanıtlanan form
 * listeden kalkar (tek yanıtlı form yeniden doldurulamaz). Liste boşsa
 * bölüm hiç çizilmez.
 */
export async function IncompleteFormsSection({ userId }: { userId: number }) {
  const forms = await listIncompleteForms(getDatabase(), userId);
  if (forms.length === 0) return null;

  return (
    <section className={styles.panel} aria-labelledby="hesap-formlar">
      <div className={styles.panelHeader}>
        <h2 id="hesap-formlar" className={styles.sectionTitle}>
          Tamamlanmamış formlar
        </h2>
        <p className={styles.sectionDescription}>
          Birkaç kısa soru: cevapların ürünü senin ihtiyaçlarına göre geliştirmemize yardımcı olur.
          Her formu bir kez yanıtlayabilirsin.
        </p>
      </div>
      <ul className={styles.rightsHistory}>
        {forms.map((item) => (
          <li key={item.slug}>
            <span>{item.title}</span>
            <a href={`/anket/${item.slug}?kaynak=hesap`}>Şimdi doldur</a>
          </li>
        ))}
      </ul>
    </section>
  );
}
