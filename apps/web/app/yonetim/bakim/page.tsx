import { MODES } from "@arilla/core/maintenance";
import { readMaintenanceAdmin } from "@arilla/core/maintenance-service";
import { requireCapability } from "../../lib/dal.ts";
import { PageHeader, Panel } from "../admin-ui.tsx";
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
        description="Değişiklikler kaydedildiğinde uygulanır. Açık ekranlar en geç yaklaşık 15 saniye içinde kontrol eder."
        actions={
          <a href="/durum" target="_blank" rel="noreferrer">
            Durum ekranını aç
          </a>
        }
      />
      <Panel id="maintenance-settings" title="Yayınlanan durum">
        <MaintenanceForm initial={data.status} />
      </Panel>
      <Panel
        id="maintenance-history"
        title="İşlem geçmişi"
        description="Bağımsız durum servisinde son 100 değişiklik tutulur."
      >
        {data.history.length === 0 ? (
          <p>Henüz değişiklik yok.</p>
        ) : (
          <ol>
            {data.history.map((entry) => (
              <li key={entry.after.version}>
                <strong>
                  {MODES[entry.before.mode]} → {MODES[entry.after.mode]}
                </strong>
                <p>{entry.reason}</p>
                <p>
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
