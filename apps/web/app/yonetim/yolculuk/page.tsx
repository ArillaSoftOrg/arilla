import { ANALYTICS_WINDOWS, getUserJourneyOverview, SMALL_CELL_MIN } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireCapability } from "../../lib/dal.ts";
import styles from "../admin.module.css";
import {
  DataBasis,
  DataTable,
  EmptyPanel,
  KeyValues,
  KpiCard,
  Notice,
  PageHeader,
  Panel,
  Tabs,
} from "../admin-ui.tsx";
import {
  activityKindLabel,
  consentKindLabel,
  formatCount,
  formatDateTime,
  formatDelta,
  formatPercent,
  hrefWith,
  ledgerReasonLabel,
  signupProviderLabel,
} from "../format.ts";

const PATH = "/yonetim/yolculuk";

function windowLabel(days: number): string {
  return days === 1 ? "Son 24 saat" : `Son ${days} gün`;
}

/**
 * Kullanıcı yolculuğu (karar 0085, `analytics.read`, yalnızca yönetici).
 * Kimliksiz toplamlar. Tam sayımla rızalı örneklem ayrı etiketlenir; örneklem
 * hücresinde 5'ten az kişi varsa sayı gizlenir. `click` ve `product_view`
 * bilerek kullanılmaz (events.md, karar 0049 §5).
 */
export default async function UserJourneyPage({
  searchParams,
}: {
  searchParams: Promise<{ gun?: string }>;
}) {
  const { actor } = await requireCapability("analytics.read");
  const params = await searchParams;
  const journey = await getUserJourneyOverview(getDatabase(), actor, { days: params.gun });
  const signUps = journey.signupsByDay.reduce((sum, row) => sum + row.signUps, 0);
  const signIns = journey.signupsByDay.reduce((sum, row) => sum + row.signIns, 0);
  const searches = journey.searchByDay.reduce((sum, row) => sum + row.searches, 0);
  const zero = journey.searchByDay.reduce((sum, row) => sum + row.zeroResults, 0);
  const label = windowLabel(journey.days).toLowerCase();

  return (
    <div className={styles.page}>
      <PageHeader
        title="Kullanıcı yolculuğu"
        description={`Kayıt, rıza, arama ve rızalı huni örneklemi. ${formatDateTime(journey.generatedAt)} itibarıyla; kimliksiz toplamlar.`}
        actions={
          <Tabs
            label="Zaman aralığı"
            items={ANALYTICS_WINDOWS.map((days) => ({
              href: hrefWith(PATH, { gun: days }),
              label: windowLabel(days),
              active: days === journey.days,
            }))}
          />
        }
      />

      <div className={styles.kpiGrid}>
        <KpiCard label="Toplam hesap" value={formatCount(journey.totalUsers)} basis="count" />
        <KpiCard
          label={`Yeni kayıt (${label})`}
          value={formatCount(signUps)}
          note={`Giriş: ${formatCount(signIns)}`}
          basis="count"
        />
        <KpiCard
          label={`Metin araması (${label})`}
          value={formatCount(searches)}
          note={`Sonuçsuz ${formatPercent(zero, searches)} · girişsizler dahil, kimliksiz`}
          basis="count"
        />
        <KpiCard
          label={`Örneklemdeki kişi (${label})`}
          value={journey.sampleUsers === null ? "Gizli" : formatCount(journey.sampleUsers)}
          note={
            journey.sampleUsers === null
              ? `${SMALL_CELL_MIN} kişiden az: gösterilmez`
              : "Girişli ve analitik rızalı kullanıcılar"
          }
          basis="consent_sample"
        />
        <KpiCard
          label="Anonim ziyaret / huni"
          value="—"
          note="Kimliksiz sayaç yok (Faz E, hukuki görüş gerekir)"
          basis="unmeasured"
        />
        <KpiCard
          label="Aktif fiyat alarmı"
          value={formatCount(journey.alerts.active)}
          note={`${label}: ${formatCount(journey.alerts.triggered)} tetiklendi`}
          basis="count"
        />
      </div>

      <div className={styles.panelGrid}>
        <Panel
          id="kayit"
          title="Kayıt ve giriş"
          description="Hizmet kaydı (auth_event); rızaya bağlı değildir."
          actions={<DataBasis kind="count" />}
          flush={journey.signupsByDay.length > 0}
        >
          <DataTable
            rows={journey.signupsByDay}
            rowKey={(row) => row.day}
            empty={<EmptyPanel title="Bu aralıkta kayıt ya da giriş yok" />}
            columns={[
              { key: "day", header: "Gün", cell: (row) => row.day },
              {
                key: "up",
                header: "Kayıt",
                numeric: true,
                cell: (row) => formatCount(row.signUps),
              },
              {
                key: "in",
                header: "Giriş",
                numeric: true,
                cell: (row) => formatCount(row.signIns),
              },
            ]}
          />
        </Panel>

        <Panel
          id="saglayici"
          title="Kayıt yöntemi"
          description="Yeni hesapların giriş sağlayıcısı."
          actions={<DataBasis kind="count" />}
        >
          {journey.signupsByProvider.length === 0 ? (
            <p className={styles.muted}>Bu aralıkta kayıt yok.</p>
          ) : (
            <KeyValues
              items={journey.signupsByProvider.map((row) => [
                signupProviderLabel(row.provider),
                `${formatCount(row.count)} · ${formatPercent(row.count, signUps)}`,
              ])}
            />
          )}
        </Panel>
      </div>

      <Panel
        id="riza"
        title="Rıza oranları"
        description="Kişi başına son karar. Oran, karar veren hesaplar içinde; kapsam tüm hesaplara göre."
        actions={<DataBasis kind="count" />}
        flush
      >
        <DataTable
          rows={journey.consent}
          rowKey={(row) => row.kind}
          stack
          columns={[
            { key: "kind", header: "İzin", cell: (row) => consentKindLabel(row.kind) },
            {
              key: "granted",
              header: "Verdi",
              numeric: true,
              cell: (row) => formatCount(row.granted),
            },
            {
              key: "denied",
              header: "Vermedi",
              numeric: true,
              cell: (row) => formatCount(row.denied),
            },
            {
              key: "rate",
              header: "Onay oranı",
              numeric: true,
              cell: (row) => formatPercent(row.granted, row.granted + row.denied),
            },
            {
              key: "coverage",
              header: "Karar kapsamı",
              numeric: true,
              cell: (row) => formatPercent(row.granted + row.denied, journey.totalUsers),
            },
          ]}
        />
      </Panel>

      <div className={styles.panelGrid}>
        <Panel
          id="arama"
          title="Arama etkinliği"
          description="Kimliksiz günlük özet (search_query_day); girişsiz aramalar dahil, e-posta/telefon içeren sorgular hiç yazılmaz."
          actions={<DataBasis kind="count" />}
          flush={journey.searchByDay.length > 0}
        >
          <DataTable
            rows={journey.searchByDay}
            rowKey={(row) => row.day}
            empty={<EmptyPanel title="Bu aralıkta metin araması yok" />}
            columns={[
              { key: "day", header: "Gün", cell: (row) => row.day },
              {
                key: "searches",
                header: "Arama",
                numeric: true,
                cell: (row) => formatCount(row.searches),
              },
              {
                key: "zero",
                header: "Sonuçsuz",
                numeric: true,
                cell: (row) => formatPercent(row.zeroResults, row.searches),
              },
              {
                key: "fallbacks",
                header: "Yedek liste",
                numeric: true,
                cell: (row) => formatCount(row.fallbacks),
              },
            ]}
          />
        </Panel>

        <Panel
          id="huni"
          title="Rızalı huni örneklemi"
          description={`Yalnızca girişli ve analitik rızalı kullanıcılar; tüm kullanıcıları temsil etmez. ${SMALL_CELL_MIN} kişiden az hücre gizlenir.`}
          actions={<DataBasis kind="consent_sample" />}
          flush
        >
          <DataTable
            rows={journey.sample}
            rowKey={(row) => row.kind}
            columns={[
              { key: "kind", header: "Adım", cell: (row) => activityKindLabel(row.kind) },
              {
                key: "events",
                header: "Olay",
                numeric: true,
                cell: (row) => (row.suppressed ? "Gizli" : formatCount(row.events ?? 0)),
              },
              {
                key: "users",
                header: "Kişi",
                numeric: true,
                cell: (row) => (row.suppressed ? "Gizli" : formatCount(row.users ?? 0)),
              },
            ]}
          />
        </Panel>
      </div>

      <div className={styles.panelGrid}>
        <Panel
          id="alarmlar"
          title="Fiyat alarmları"
          description="Alarm tablosundan toplamlar; bildirim e-postasının teslimi ölçülmüyor."
          actions={<DataBasis kind="count" />}
        >
          <KeyValues
            items={[
              ["Aktif alarm", formatCount(journey.alerts.active)],
              [`Oluşturulan (${label})`, formatCount(journey.alerts.created)],
              [`Tetiklenen (${label})`, formatCount(journey.alerts.triggered)],
              [`Bildirilen (${label})`, formatCount(journey.alerts.notified)],
              ["E-posta teslimi", <DataBasis key="d" kind="unmeasured" />],
            ]}
          />
        </Panel>

        <Panel
          id="davet"
          title="Davet ve bonus"
          description="Davet durumu ve bonus defterinin nedene göre toplamı (kişi bazında değil)."
          actions={<DataBasis kind="count" />}
        >
          <KeyValues
            items={[
              [`Yeni davet (${label})`, formatCount(journey.referrals.created)],
              [`Nitelikli olan (${label})`, formatCount(journey.referrals.qualified)],
              ["Bekleyen davet (toplam)", formatCount(journey.referrals.pending)],
              ...journey.bonus.map(
                (row) =>
                  [
                    `Bonus: ${ledgerReasonLabel(row.reason)}`,
                    `${formatCount(row.entries)} kayıt · ${formatDelta(row.delta)} hak`,
                  ] as [string, string],
              ),
            ]}
          />
        </Panel>
      </div>

      <Notice title="Bilerek kullanılmayan veri">
        Mağaza çıkışları (click) davranış analitiğine kaynak olmaz; affiliate ekranında yalnızca
        attribution toplamı olarak görünür. Ürün görüntüleme geçmişi (product_view) kullanıcının
        kendi geçmişidir, analitik rızası değildir.
      </Notice>
    </div>
  );
}
