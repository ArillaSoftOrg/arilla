import { CONFIG_GROUPS, type ConfigEntry, getConfigView } from "@arilla/core";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import {
  DataTable,
  Notice,
  PageHeader,
  Panel,
  StatusBadge,
  type StatusTone,
} from "../admin-ui.tsx";
import { configGroupLabel, configStateLabel, formatCount, quotaPoolLabel } from "../format.ts";

/**
 * Etkin yapılandırma (karar 0086, `config.read`, yalnızca yönetici). SALT
 * OKUNUR; çalışırken değiştirme yok. Sır değerleri core'dan hiç gelmez
 * (`value: null`); burada yalnızca durumları gösterilir.
 */
const STATE_TONE: Record<string, StatusTone> = {
  set: "success",
  default: "neutral",
  missing: "warning",
  invalid: "critical",
  unknown: "info",
  code: "neutral",
};

const WINDOW_LABELS: Record<string, string> = {
  hour: "Saat",
  day: "Gün",
  week: "Hafta",
  month: "Ay",
};

export default async function ConfigPage() {
  const { actor } = await requireCapability("config.read");
  const view = getConfigView(actor);
  const invalid = view.entries.filter((entry) => entry.state === "invalid").length;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Yapılandırma"
        description="Bu web sürecinin etkin özellik bayrakları, kotaları ve tavanları. Salt okunur; değişiklik dağıtım ortamından yapılır. Sırların değeri asla gösterilmez, yalnızca tanımlı olup olmadıkları."
      />

      {invalid > 0 ? (
        <Notice tone="warning" title={`${formatCount(invalid)} ayar geçersiz`}>
          Geçersiz değerler kod varsayılanına düşer ya da özelliği kapatır. Satırdaki nota bakın.
        </Notice>
      ) : null}

      {CONFIG_GROUPS.map((group) => {
        const rows = view.entries.filter((entry) => entry.group === group);
        if (rows.length === 0) return null;
        return (
          <Panel key={group} id={`grup-${group}`} title={configGroupLabel(group)} flush>
            <DataTable<ConfigEntry>
              rows={rows}
              rowKey={(row) => row.key}
              stack
              columns={[
                {
                  key: "label",
                  header: "Ayar",
                  cell: (row) => (
                    <span className={styles.list}>
                      <span>{row.label}</span>
                      <code className={styles.meta}>{row.key}</code>
                    </span>
                  ),
                },
                {
                  key: "state",
                  header: "Durum",
                  cell: (row) => (
                    <StatusBadge tone={STATE_TONE[row.state] ?? "neutral"}>
                      {configStateLabel(row.state)}
                    </StatusBadge>
                  ),
                },
                {
                  key: "value",
                  header: "Etkin değer",
                  cell: (row) =>
                    row.secret ? (
                      <span className={styles.meta}>Gizli</span>
                    ) : (
                      (row.value ?? <span className={styles.meta}>—</span>)
                    ),
                },
                {
                  key: "note",
                  header: "Not",
                  cell: (row) => <span className={styles.meta}>{row.note ?? ""}</span>,
                },
              ]}
            />
          </Panel>
        );
      })}

      <Panel
        id="kotalar"
        title="Kullanıcı kotaları"
        description="Kod sabiti (quota/policy.ts)."
        flush
      >
        <DataTable
          rows={view.quotas}
          rowKey={(row) => row.pool}
          stack
          columns={[
            { key: "pool", header: "Havuz", cell: (row) => quotaPoolLabel(row.pool) },
            ...["hour", "day", "week", "month"].map((window) => ({
              key: window,
              header: WINDOW_LABELS[window] ?? window,
              numeric: true,
              cell: (row: (typeof view.quotas)[number]) =>
                formatCount(row.windows.find((item) => item.window === window)?.limit ?? 0),
            })),
          ]}
        />
      </Panel>

      <Panel id="tavanlar" title="Maliyet ve hız tavanları" description="Kod sabitleri." flush>
        <DataTable
          rows={view.caps}
          rowKey={(row) => row.key}
          stack
          columns={[
            { key: "label", header: "Tavan", cell: (row) => row.label },
            { key: "value", header: "Değer", numeric: true, cell: (row) => formatCount(row.value) },
          ]}
        />
      </Panel>
    </div>
  );
}
