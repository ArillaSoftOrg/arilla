import {
  type AdminActor,
  getTrafficSummary,
  parseTrafficRange,
  redisTrafficCacheStore,
} from "@arilla/core";
import { KpiCard, KpiGroup } from "./admin-ui.tsx";
import { formatCount, trafficDelta, trafficErrorLabel } from "./format.ts";

/**
 * Genel bakış trafik özeti (karar 0087): son 7 tamamlanmış gün, yalnızca
 * toplamlar (tek GA4 isteği, önbellekli). Mevcut göstergelerin hiçbiri
 * ziyaretçi/oturum ölçmediği için tekrar yok. Ayrıntı `/yonetim/trafik`.
 */
export async function TrafficSummaryGroup({ actor }: { actor: AdminActor }) {
  const range = parseTrafficRange({ gun: "7" }, new Date());
  const result = await getTrafficSummary(actor, { range }, { store: redisTrafficCacheStore() });
  const href = "/yonetim/trafik?gun=7";
  const title = "Site trafiği (7 gün, GA4 rızalı örneklem)";

  if (result.state === "not_configured" || result.state === "invalid_config") {
    return (
      <KpiGroup title={title}>
        <KpiCard
          label="Site trafiği"
          value={result.state === "not_configured" ? "Bağlı değil" : "Ayar geçersiz"}
          note="GA4 raporlaması yapılandırılmadı; sayı üretilmez."
          tone="warning"
          basis="external"
          href={href}
        />
      </KpiGroup>
    );
  }
  if (result.state === "error") {
    return (
      <KpiGroup title={title}>
        <KpiCard
          label="Site trafiği"
          value="Alınamadı"
          note={trafficErrorLabel(result.error)}
          tone="warning"
          href={href}
        />
      </KpiGroup>
    );
  }

  const { current, previous } = result.data.totals;
  const note = (now: number, before: number) => {
    const delta = trafficDelta(now, before);
    return `Önceki 7 gün ${formatCount(before)}${delta ? ` · ${delta}` : ""}${result.state === "stale" ? " · eski veri" : ""}`;
  };
  return (
    <KpiGroup title={title}>
      <KpiCard
        label="Kullanıcı"
        value={formatCount(current.users)}
        note={note(current.users, previous.users)}
        basis="consent_sample"
        href={href}
      />
      <KpiCard
        label="Oturum"
        value={formatCount(current.sessions)}
        note={note(current.sessions, previous.sessions)}
        basis="consent_sample"
        href={href}
      />
      <KpiCard
        label="Sayfa görüntüleme"
        value={formatCount(current.pageViews)}
        note={note(current.pageViews, previous.pageViews)}
        basis="consent_sample"
        href={href}
      />
    </KpiGroup>
  );
}
