import { getEarlyAccessCounterAdmin } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import { formatDateTime } from "../format.ts";
import { setOffPlatformCountAction } from "./actions.ts";

/**
 * Erken erişim sayacı (docs/decisions/0065). Herkese görünen çubuk =
 * platform dışı gerçek başvurular (burada elle girilir) + sitedeki gerçek
 * kayıtlar. Otomatik ya da rastgele artış yoktur; her kişi gerçek olmalıdır.
 * Yalnızca `early_access.manage` (yönetici); her değişiklik denetime yazılır.
 */
export default async function EarlyAccessCounterPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; hata?: string }>;
}) {
  const { actor } = await requireCapability("early_access.manage");
  const params = await searchParams;
  const view = await getEarlyAccessCounterAdmin(getDatabase(), actor);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Erken erişim sayacı</h1>
        <p className={styles.muted}>
          Sitede gösterilen sayı, siteden kayıt olanlarla aşağıdaki platform dışı başvuruların
          toplamıdır. Platform dışı sayıya yalnızca gerçekten var olan kişileri (ör. e-postayla
          başvuranlar) ekleyin.
        </p>
      </header>

      {params.ok ? <p className={styles.notice}>Sayı güncellendi.</p> : null}
      {params.hata ? (
        <p className={`${styles.notice} ${styles.noticeError}`} role="alert">
          {params.hata}
        </p>
      ) : null}

      <div className={styles.tiles}>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Sitede gösterilen</span>
          <span className={styles.tileValue}>
            {view.count} / {view.target}
          </span>
          <span className={styles.tileNote}>%{view.percent}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Siteden kayıt (otomatik)</span>
          <span className={styles.tileValue}>{view.onPlatformCount}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Platform dışı (elle)</span>
          <span className={styles.tileValue}>{view.offPlatformCount}</span>
          <span className={styles.tileNote}>
            {view.updatedAt
              ? `Son güncelleme: ${formatDateTime(view.updatedAt)}`
              : "Hiç güncellenmedi"}
          </span>
        </div>
      </div>

      <h2 className={styles.sectionTitle}>Platform dışı sayıyı güncelle</h2>
      <form action={setOffPlatformCountAction} className={styles.formGrid}>
        <label>
          <span className={styles.meta}>Yeni platform dışı toplam</span>
          <input
            name="count"
            type="number"
            inputMode="numeric"
            min={0}
            max={1000000}
            step={1}
            required
            defaultValue={view.offPlatformCount}
            className={styles.textInput}
          />
        </label>
        <label>
          <span className={styles.meta}>Gerekçe (kaynak ve tarih)</span>
          <input
            name="reason"
            type="text"
            minLength={5}
            maxLength={200}
            required
            placeholder="ör. E-postayla gelen 12 yeni başvuru, 7 Ekim"
            className={styles.textInput}
          />
        </label>
        <div>
          <button type="submit">Kaydet</button>
        </div>
        <p className={styles.muted}>
          Bu değer yeni toplamdır (eklenen sayı değil). Değişiklik denetim kaydına gerekçeyle
          yazılır.
        </p>
      </form>
    </div>
  );
}
