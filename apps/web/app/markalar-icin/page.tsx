import type { Metadata } from "next";
import { PartnershipPlaceholder } from "../partnership-placeholder.tsx";
import { SITE_BRAND } from "../site-config.ts";

export const metadata: Metadata = {
  title: `Markalar İçin – ${SITE_BRAND}`,
  description: `${SITE_BRAND} marka iş ortaklığı sayfası hazırlanıyor.`,
  alternates: { canonical: "/markalar-icin" },
};

export default function MarkalarIcinPage() {
  return <PartnershipPlaceholder title="Markalar İçin" />;
}
