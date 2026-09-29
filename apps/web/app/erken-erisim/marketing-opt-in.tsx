import { getMarketingEmailPreference, MARKETING_EMAIL_CONSENT_TEXT } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { Button } from "@arilla/ui";
import type { ReactElement } from "react";
import { MARKETING_EMAIL_COPY } from "../marketing-email-copy.ts";
import { saveEarlyAccessMarketingAction } from "./marketing-actions.ts";
import styles from "./marketing-opt-in.module.css";

/**
 * Kayıttan sonraki ilk ekranda isteğe bağlı pazarlama e-postası rızası.
 * Kullanım koşulları/gizlilik kabulünden ayrıdır, işaretsiz gelir ve erken
 * erişimi engellemez. Gösterilen durum sunucudan okunur.
 *
 * Bileşen değil, sayfanın `await` ettiği işlev: durum render'dan önce
 * okunur, sayfa askıya alınmaz.
 */
export async function renderMarketingOptIn(userId: number): Promise<ReactElement | null> {
  const preference = await getMarketingEmailPreference(getDatabase(), userId);
  if (!preference.hasEmail) return null;

  if (preference.optedIn) {
    return (
      <div className={styles.box}>
        <p className={styles.hint}>{MARKETING_EMAIL_COPY.optedInNote}</p>
      </div>
    );
  }

  return (
    <form action={saveEarlyAccessMarketingAction} className={styles.box}>
      <label className={styles.choice}>
        <input type="checkbox" name="marketing_email" />
        <span>{MARKETING_EMAIL_CONSENT_TEXT.text}</span>
      </label>
      <div className={styles.row}>
        <p className={styles.hint}>{MARKETING_EMAIL_COPY.optInOptional}</p>
        <Button type="submit" variant="secondary" shape="pill">
          {MARKETING_EMAIL_COPY.optInSubmit}
        </Button>
      </div>
    </form>
  );
}
