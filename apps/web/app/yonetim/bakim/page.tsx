import { MODES } from "@arilla/core/maintenance";
import { readMaintenanceAdmin } from "@arilla/core/maintenance-service";
import { requireCapability } from "../../lib/dal.ts";
import { PageHeader, Panel } from "../admin-ui.tsx";
import styles from "./status-form.module.css";
import { MaintenanceForm } from "./status-form.tsx";

export default async function MaintenancePage() {
  const { actor } = await requireCapability("maintenance.read");
  let data: Awaited<ReturnType<typeof readMaintenanceAdmin>>;
  try {
    data = await readMaintenanceAdmin(actor);
  } catch {
    return (
      <>
        <PageHeader title="Bakım ve sistem durumu" />
        <p role="alert">
          Bakım servisine ulaşılamıyor veya henüz yapılandırılmadı. Bağımsız durum servisini ve
          bağlantı ayarlarını kontrol et.
        </p>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Bakım ve sistem durumu"
        description="Hizmetlerin durumunu yönet, kullanıcılarını bilgilendir. Yayınladığın değişiklikler yaklaşık 15 saniye içinde ekranlara yansır."
        actions={
          <a className={styles.externalLink} href="/durum" target="_blank" rel="noreferrer">
            Durum ekranını aç <span aria-hidden="true">↗</span>
          </a>
        }
      />
      <Panel
        id="maintenance-settings"
        title="Durum yönetimi"
        description="Önce modu seç, mesajını hazırla ve önizlemeyi kontrol ederek yayınla."
      >
        <MaintenanceForm initial={data.status} />
      </Panel>
      <Panel
        id="maintenance-history"
        title="İşlem geçmişi"
        description="Bağımsız durum servisinde son 100 değişiklik tutulur."
      >
        {data.history.length === 0 ? (
          <p className={styles.emptyHistory}>
            Henüz değişiklik yok. İlk yayınladığın durum burada görünecek.
          </p>
        ) : (
          <ol className={styles.history}>
            {data.history.map((entry) => (
              <li key={entry.after.version}>
                <strong>
                  {MODES[entry.before.mode]}{" "}
                  <span className={styles.historyArrow} aria-hidden="true">
                    →
                  </span>
                  <span className={styles.srOnly}>modundan</span> {MODES[entry.after.mode]}
                </strong>
                <p>{entry.reason}</p>
                <p className={styles.meta}>
                  Yönetici #{entry.actorId} ·{" "}
                  {new Date(entry.at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })} ·
                  Sürüm {entry.after.version}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}
