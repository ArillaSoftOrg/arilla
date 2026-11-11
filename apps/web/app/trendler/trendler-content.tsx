import { getPublicTrends } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { TrendlerView } from "./trendler-view.tsx";
/** Read-only data boundary; presentation is shared with the design preview. */
export async function TrendlerContent() {
  const trends = await getPublicTrends(getDatabase());
  return <TrendlerView trends={trends} />;
}
